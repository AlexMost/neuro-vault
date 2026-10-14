import fs from 'node:fs';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { DaemonInfo } from './info.js';
import { defaultLockFs, parseHolder, type LockFs } from './lock.js';
import { probeSocket, type SocketConnect, type Timers } from './probe.js';
import type { DaemonInfoResult } from './protocol.js';

/** How long `status` / `stop` wait for one JSON-RPC answer. */
export const CALL_TIMEOUT_MS = 2_000;
/** How long `stop` waits for a stopped daemon's info file to go (its own deadline + slack). */
export const STOP_WAIT_MS = 6_000;
const STOP_POLL_MS = 100;

export interface OutStream {
  write(chunk: string): boolean;
}

export interface DaemonFs extends LockFs {
  /** Entry names in `dir`; empty when it does not exist. */
  readdir(dir: string): string[];
  rmrf(dir: string): void;
  chmod(p: string, mode: number): void;
  exists(p: string): boolean;
}

export function defaultDaemonFs(): DaemonFs {
  return {
    ...defaultLockFs(),
    readdir: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    rmrf: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    chmod: (p, mode) => fs.chmodSync(p, mode),
    exists: (p) => fs.existsSync(p),
  };
}

export interface AdminDeps {
  cacheBase: string;
  fs: DaemonFs;
  readInfo: (file: string) => DaemonInfo | undefined;
  connect: SocketConnect;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: 'SIGTERM') => void;
  timers: Timers;
  stdout: OutStream;
  stderr: OutStream;
}

function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => void timers.setTimeout(resolve, ms));
}

/**
 * One JSON-RPC request on a fresh connection. The result on success;
 * `undefined` on a failed connect, an error response, a broken line, a closed
 * socket or no answer within `CALL_TIMEOUT_MS`.
 */
async function callOnce<T>(
  d: AdminDeps,
  socketPath: string,
  method: string,
): Promise<T | undefined> {
  let socket;
  try {
    socket = await d.connect(socketPath);
  } catch {
    return undefined;
  }
  const connected = socket;
  return new Promise<T | undefined>((resolve) => {
    const buffer = new ReadBuffer();
    let done = false;
    const finish = (value: T | undefined): void => {
      if (done) return;
      done = true;
      d.timers.clearTimeout(timer);
      connected.destroy();
      resolve(value);
    };
    const timer = d.timers.setTimeout(() => finish(undefined), CALL_TIMEOUT_MS);
    // `defaultConnect` drops its own error listener once connected: attach ours now.
    connected.on('error', () => finish(undefined));
    connected.on('close', () => finish(undefined));
    connected.on('data', (chunk: Buffer) => {
      buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = buffer.readMessage();
        } catch {
          return finish(undefined);
        }
        if (!message) return;
        if (isJSONRPCResultResponse(message)) return finish(message.result as T);
        if (isJSONRPCErrorResponse(message)) return finish(undefined);
      }
    });
    connected.write(serializeMessage({ jsonrpc: '2.0', id: 1, method }));
  });
}

type Entry =
  | { kind: 'valid'; dir: string; info: DaemonInfo }
  | { kind: 'starting'; dir: string; name: string }
  | { kind: 'unreadable'; dir: string; name: string };

/**
 * Every `daemons/*` directory with a daemon.json. An unreadable one under a
 * live lock is a daemon between taking the lock and writing its info; one
 * with no daemon.json at all is skipped for the same reason.
 */
function scan(d: AdminDeps): Entry[] {
  const root = path.join(d.cacheBase, 'daemons');
  const entries: Entry[] = [];
  for (const name of d.fs.readdir(root).sort()) {
    const dir = path.join(root, name);
    const infoFile = path.join(dir, 'daemon.json');
    if (!d.fs.exists(infoFile)) continue;
    const info = d.readInfo(infoFile);
    if (info !== undefined) {
      entries.push({ kind: 'valid', dir, info });
      continue;
    }
    if (!d.fs.exists(infoFile)) continue; // removed while we read it: a daemon stopping
    const raw = d.fs.read(path.join(dir, 'daemon.lock'));
    const holder = raw === undefined ? undefined : parseHolder(raw);
    const live = holder !== undefined && d.isAlive(holder);
    entries.push({ kind: live ? 'starting' : 'unreadable', dir, name });
  }
  return entries;
}

async function isListening(d: AdminDeps, socketPath: string): Promise<boolean> {
  return (await probeSocket(socketPath, { connect: d.connect, timers: d.timers })) === 'listening';
}

export async function runStatus(d: AdminDeps): Promise<number> {
  let printed = 0;
  const print = (line: string): void => {
    printed += 1;
    d.stdout.write(`${line}\n`);
  };
  for (const entry of scan(d)) {
    if (entry.kind === 'starting') {
      print(`${entry.name}  starting`);
      continue;
    }
    if (entry.kind === 'unreadable') {
      print(`${entry.name}  stale (unreadable daemon.json)  (swept)`);
      d.fs.rmrf(entry.dir);
      continue;
    }
    const { info, dir } = entry;
    if (!(await isListening(d, info.socket))) {
      print(`${info.version}  pid ${info.pid}  stale  (swept)`);
      d.fs.rmrf(dir);
      continue;
    }
    const live = await callOnce<DaemonInfoResult>(d, info.socket, 'daemon.info');
    if (live === undefined) {
      print(`${info.version}  pid ${info.pid}  busy (no answer)  ${info.socket}`);
      continue;
    }
    const loaded = live.services.embed.loaded.join(', ');
    print(
      `${live.version}  pid ${live.pid}  clients ${live.clients}  loaded [${loaded}]  alive  ${info.socket}`,
    );
  }
  if (printed === 0) print('no daemon known');
  return 0;
}

/** Wait for a stopped daemon's info file to go: the last sign it cleaned up. */
async function waitGone(d: AdminDeps, infoFile: string): Promise<boolean> {
  for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
    if (!d.fs.exists(infoFile)) return true;
    await sleep(d.timers, STOP_POLL_MS);
  }
  return !d.fs.exists(infoFile);
}

export async function runStop(d: AdminDeps): Promise<number> {
  const valid = scan(d).filter((e) => e.kind === 'valid');
  if (valid.length === 0) {
    d.stdout.write('no daemon known\n');
    return 0;
  }
  for (const { dir, info } of valid) {
    const label = `${info.version} (pid ${info.pid})`;
    if (!(await isListening(d, info.socket))) {
      d.stdout.write(`${info.version}  pid ${info.pid}  not running\n`);
      continue;
    }
    const answered = await callOnce<Record<string, never>>(d, info.socket, 'daemon.shutdown');
    if (answered === undefined) {
      if (!d.isAlive(info.pid)) {
        d.stderr.write(`daemon ${label} did not answer and its pid is not alive\n`);
        continue;
      }
      try {
        d.kill(info.pid, 'SIGTERM');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        d.stderr.write(`could not signal daemon ${label}: ${message}\n`);
        continue;
      }
    }
    if (await waitGone(d, path.join(dir, 'daemon.json'))) {
      d.stdout.write(`stopped ${label}\n`);
    } else {
      d.stderr.write(
        `${info.version}  pid ${info.pid}  still running after ${STOP_WAIT_MS / 1000} s\n`,
      );
    }
  }
  return 0;
}
