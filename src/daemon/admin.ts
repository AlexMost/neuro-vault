import fs from 'node:fs';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { DaemonInfo } from './info.js';
import { claimLock, defaultLockFs, parseHolder, type LockFs } from './lock.js';
import { probeSocket, type SocketConnect, type Timers } from './probe.js';
import type { DaemonInfoResult } from './protocol.js';
import type { SocketDirFs } from './socket-dir.js';

/** How long `status` / `stop` wait for one JSON-RPC answer. */
export const CALL_TIMEOUT_MS = 2_000;
/** How long `stop` waits for a stopped daemon's info file to go (its own deadline + slack). */
export const STOP_WAIT_MS = 6_000;
const STOP_POLL_MS = 100;

export interface OutStream {
  write(chunk: string): boolean;
}

export interface DaemonFs extends LockFs, SocketDirFs {
  /** Entry names in `dir`; empty when it does not exist. */
  readdir(dir: string): string[];
  rmrf(dir: string): void;
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
    lstat: (p) => fs.lstatSync(p),
  };
}

export interface AdminDeps {
  cacheBase: string;
  /** This status/stop process's own pid: what it writes into a lock it takes over to sweep. */
  pid: number;
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

/** `raw` is the lock as judged (undefined = none), what `sweep` claims. */
type Entry =
  | { kind: 'valid'; dir: string; info: DaemonInfo }
  | { kind: 'starting'; dir: string; name: string }
  | { kind: 'unreadable'; dir: string; name: string; raw: string | undefined }
  | { kind: 'lockOnly'; dir: string; name: string; raw: string }
  | { kind: 'empty'; dir: string; name: string };

/** Every `daemons/*` directory name, sorted. */
function scan(d: AdminDeps): string[] {
  return d.fs.readdir(path.join(d.cacheBase, 'daemons')).sort();
}

/**
 * What one `daemons/*` directory holds. An unreadable daemon.json, or a lock
 * with no daemon.json, under a live lock is a daemon between taking the lock
 * and writing its info: `starting`. Under a dead or unnamed holder it is stale.
 * A directory with neither file is what a clean stop leaves behind. Undefined
 * when daemon.json vanished while we read it: a daemon stopping.
 */
function classify(d: AdminDeps, name: string): Entry | undefined {
  const dir = path.join(d.cacheBase, 'daemons', name);
  const infoFile = path.join(dir, 'daemon.json');
  if (!d.fs.exists(infoFile)) {
    const { raw, holder } = readLock(d, dir);
    if (raw === undefined) return { kind: 'empty', dir, name };
    if (holder !== undefined && d.isAlive(holder)) return { kind: 'starting', dir, name };
    return { kind: 'lockOnly', dir, name, raw };
  }
  const info = d.readInfo(infoFile);
  if (info !== undefined) return { kind: 'valid', dir, info };
  if (!d.fs.exists(infoFile)) return undefined;
  const { raw, holder } = readLock(d, dir);
  if (holder !== undefined && d.isAlive(holder)) return { kind: 'starting', dir, name };
  return { kind: 'unreadable', dir, name, raw };
}

async function isListening(d: AdminDeps, socketPath: string): Promise<boolean> {
  return (await probeSocket(socketPath, { connect: d.connect, timers: d.timers })) === 'listening';
}

function readLock(d: AdminDeps, dir: string): { raw: string | undefined; holder?: number } {
  const raw = d.fs.read(path.join(dir, 'daemon.lock'));
  return { raw, holder: raw === undefined ? undefined : parseHolder(raw) };
}

/**
 * Remove an entry judged stale, but only once we hold its lock: `claimLock`
 * takes it over only if it still holds `raw`, the lock we judged, so a daemon
 * that took the lock meanwhile keeps it and its state. `rmrf` removes our own
 * lock with the directory. False when the lock changed: the entry is kept.
 */
function sweep(d: AdminDeps, dir: string, raw: string | undefined): boolean {
  if (!claimLock(path.join(dir, 'daemon.lock'), raw, { pid: d.pid, fs: d.fs })) return false;
  d.fs.rmrf(dir);
  return true;
}

type Silent = { kind: 'starting'; holder: number } | { kind: 'stale'; raw: string | undefined };

/**
 * A valid entry whose socket refuses or is absent. A daemon that died without
 * cleaning up leaves its daemon.json behind; a new daemon for the same key
 * takes the lock and replaces the socket before it writes its own info. Until
 * then the old entry looks stale, but it is the new daemon's: `starting`. A
 * lock naming the info's own pid is stale even if that pid is alive (reused).
 */
function judgeSilent(d: AdminDeps, dir: string, info: DaemonInfo): Silent {
  const { raw, holder } = readLock(d, dir);
  if (holder !== undefined && holder !== info.pid && d.isAlive(holder)) {
    return { kind: 'starting', holder };
  }
  return { kind: 'stale', raw };
}

export async function runStatus(d: AdminDeps): Promise<number> {
  let printed = 0;
  const print = (line: string): void => {
    printed += 1;
    d.stdout.write(`${line}\n`);
  };
  for (const name of scan(d)) {
    const entry = classify(d, name);
    if (entry === undefined) continue;
    if (entry.kind === 'empty') {
      sweep(d, entry.dir, undefined);
      continue;
    }
    if (entry.kind === 'starting') {
      print(`${entry.name}  starting`);
      continue;
    }
    if (entry.kind === 'unreadable' || entry.kind === 'lockOnly') {
      const what = entry.kind === 'unreadable' ? 'unreadable daemon.json' : 'lock only';
      print(
        sweep(d, entry.dir, entry.raw)
          ? `${entry.name}  stale (${what})  (swept)`
          : `${entry.name}  starting`,
      );
      continue;
    }
    const { info, dir } = entry;
    if (!(await isListening(d, info.socket))) {
      const silent = judgeSilent(d, dir, info);
      if (silent.kind === 'stale' && sweep(d, dir, silent.raw)) {
        print(`${info.version}  pid ${info.pid}  stale  (swept)`);
        continue;
      }
      // Live holder, or the lock changed before we could claim it: whoever holds it now.
      const holder = silent.kind === 'starting' ? silent.holder : readLock(d, dir).holder;
      print(`${info.version}  pid ${holder ?? '?'}  starting`);
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
  const valid = scan(d)
    .map((name) => classify(d, name))
    .filter((e) => e?.kind === 'valid');
  if (valid.length === 0) {
    d.stdout.write('no daemon known\n');
    return 0;
  }
  for (const { dir, info } of valid) {
    const label = `${info.version} (pid ${info.pid})`;
    if (!(await isListening(d, info.socket))) {
      const silent = judgeSilent(d, dir, info);
      if (silent.kind === 'starting') {
        d.stdout.write(`${info.version}  pid ${silent.holder}  starting\n`);
        continue;
      }
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
