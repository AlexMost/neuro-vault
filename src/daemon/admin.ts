import fs from 'node:fs';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

import type { ILexicalInfo, IProfileInfo, IVaultInfo } from '../lib/vault-entry/index.js';
import { packageMeta } from '../package-meta.js';

import type { DaemonInfo } from './info.js';
import { claimLock, defaultLockFs, parseHolder, type LockFs } from './lock.js';
import type { Timers } from '../lib/timers.js';
import { probeSocket, type SocketConnect } from './probe.js';
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
  now: () => Date;
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
 * A directory with nothing in it at all is `empty`. Undefined when there is
 * nothing to report: daemon.json vanished while we read it (a daemon
 * stopping), or neither file is there but something else is, such as
 * daemon.log, the last run's log or a spawner's log opened before its daemon
 * takes the lock. That one is left alone.
 */
function classify(d: AdminDeps, name: string): Entry | undefined {
  const dir = path.join(d.cacheBase, 'daemons', name);
  const infoFile = path.join(dir, 'daemon.json');
  if (!d.fs.exists(infoFile)) {
    const { raw, holder } = readLock(d, dir);
    if (raw === undefined) {
      return d.fs.readdir(dir).length === 0 ? { kind: 'empty', dir, name } : undefined;
    }
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

type Write = (line: string) => void;

/** stdout and stderr lines, counted, so a run that reported nothing can say so. */
function reporter(d: AdminDeps): { out: Write; err: Write; reported: () => number } {
  let reported = 0;
  return {
    out: (line) => {
      reported += 1;
      d.stdout.write(`${line}\n`);
    },
    err: (line) => {
      reported += 1;
      d.stderr.write(`${line}\n`);
    },
    reported: () => reported,
  };
}

/**
 * Run `work` for every `daemons/*` entry. One that throws (an unreadable lock:
 * EACCES, EISDIR) is reported on stderr as `<dir name>: <message>` and the rest
 * go on; it is never swept, since the throw comes before any claim.
 */
async function forEachEntry(
  d: AdminDeps,
  err: Write,
  work: (entry: Entry) => Promise<void>,
): Promise<void> {
  for (const name of scan(d)) {
    try {
      const entry = classify(d, name);
      if (entry !== undefined) await work(entry);
    } catch (error) {
      err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function statusOne(d: AdminDeps, entry: Entry, print: Write): Promise<void> {
  if (entry.kind === 'empty') {
    sweep(d, entry.dir, undefined);
    return;
  }
  if (entry.kind === 'starting') {
    print(`${entry.name}  starting`);
    return;
  }
  if (entry.kind === 'unreadable' || entry.kind === 'lockOnly') {
    const what = entry.kind === 'unreadable' ? 'unreadable daemon.json' : 'lock only';
    print(
      sweep(d, entry.dir, entry.raw)
        ? `${entry.name}  stale (${what})  (swept)`
        : `${entry.name}  starting`,
    );
    return;
  }
  const { info, dir } = entry;
  if (!(await isListening(d, info.socket))) {
    const silent = judgeSilent(d, dir, info);
    if (silent.kind === 'stale' && sweep(d, dir, silent.raw)) {
      print(`${info.version}  pid ${info.pid}  stale  (swept)`);
      return;
    }
    // Live holder, or the lock changed before we could claim it: whoever holds it now.
    const holder = silent.kind === 'starting' ? silent.holder : readLock(d, dir).holder;
    print(`${info.version}  pid ${holder ?? '?'}  starting`);
    return;
  }
  const live = await callOnce<DaemonInfoResult>(d, info.socket, 'daemon.info');
  if (live === undefined) {
    print(`${info.version}  pid ${info.pid}  busy (no answer)  ${info.socket}`);
    return;
  }
  const loaded = live.services.embed.loaded.join(', ');
  print(
    `${live.version}  pid ${live.pid}  clients ${live.clients}  loaded [${loaded}]  alive  ${info.socket}`,
  );
  // A daemon of another version answers without `vault`, and a later one may shape it
  // differently: print what is recognisable, never fail on the rest.
  const vaults: unknown = (live.services as { vault?: unknown }).vault;
  for (const vault of Array.isArray(vaults) ? (vaults as Array<Partial<IVaultInfo> | null>) : []) {
    if (typeof vault !== 'object' || vault === null) continue;
    print(vaultLine(vault, d.now()));
    const lexical = lexicalLine(vault.lexical);
    if (lexical !== undefined) print(lexical);
    const profiles: unknown = vault.profiles;
    for (const profile of Array.isArray(profiles) ? (profiles as unknown[]) : []) {
      if (typeof profile === 'object' && profile !== null)
        print(profileLine(profile as IProfileInfo));
    }
  }
}

function vaultLine(vault: Partial<IVaultInfo>, now: Date): string {
  const clients = vault.clients ?? 0;
  const who = clients > 0 ? `clients ${clients}` : idleFor(vault.idle_since, now);
  return `  vault ${vault.vault ?? '?'}  ${who}`;
}

/** `idle 12m (since <iso>)`: how long, then when; `idle since ?` when the time is missing or unparsable. */
function idleFor(since: unknown, now: Date): string {
  const at = typeof since === 'string' ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(at)) return `idle since ${typeof since === 'string' ? since : '?'}`;
  const minutes = Math.max(0, Math.floor((now.getTime() - at) / 60_000));
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `idle ${span} (since ${since as string})`;
}

/**
 * The vault's lexical cache, or `undefined` when the daemon sent none: a daemon of another build
 * answers without `lexical`, or with a shape this one does not recognise.
 */
function lexicalLine(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const lexical = raw as Partial<ILexicalInfo>;
  if (lexical.state === 'warming') return '    lexical  warming';
  if (lexical.state !== 'ready') return undefined;
  const parts = ['lexical', 'ready'];
  if (typeof lexical.notes === 'number') parts.push(`${lexical.notes} notes`);
  const last: unknown = lexical.last_refresh;
  if (typeof last === 'object' && last !== null) {
    const refresh = last as Partial<NonNullable<ILexicalInfo['last_refresh']>>;
    // A partial object (another build's shape) prints no refresh segment rather than "undefined".
    if (
      typeof refresh.at === 'string' &&
      typeof refresh.parsed === 'number' &&
      typeof refresh.ms === 'number'
    ) {
      parts.push(`last refresh ${refresh.at} ~${refresh.parsed} parsed ${refresh.ms} ms`);
    }
  }
  return `    ${parts.join('  ')}`;
}

function profileLine(profile: IProfileInfo): string {
  const parts = [profile.profile];
  switch (profile.state) {
    case 'indexing':
      parts.push(
        `indexing${profile.total === undefined ? '' : ` ${profile.indexed ?? 0}/${profile.total}`}`,
      );
      break;
    case 'ready':
      parts.push('ready');
      if (profile.notes !== undefined) parts.push(`${profile.notes} notes`);
      break;
    case 'unavailable':
      parts.push('unavailable');
      if (profile.reason !== undefined) parts.push(profile.reason);
      break;
    default:
      parts.push(profile.state);
  }
  // Another daemon version may send null or another shape here; print only what is recognisable.
  const raw: unknown = profile.last_reconcile;
  if (typeof raw === 'object' && raw !== null) {
    const last = raw as Partial<NonNullable<IProfileInfo['last_reconcile']>>;
    parts.push(
      `last reconcile ${last.at} +${last.added} ~${last.changed} -${last.removed} ${last.ms} ms`,
    );
  }
  return `    ${parts.join('  ')}`;
}

export async function runStatus(d: AdminDeps): Promise<number> {
  const { out, err, reported } = reporter(d);
  await forEachEntry(d, err, (entry) => statusOne(d, entry, out));
  if (reported() === 0) out('no daemon known');
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

const notStopped = `starting — not stopped; run \`${packageMeta.name} daemon stop\` again`;

/** Stop one valid entry. */
async function stopOne(
  d: AdminDeps,
  dir: string,
  info: DaemonInfo,
  out: Write,
  err: Write,
): Promise<void> {
  const label = `${info.version} (pid ${info.pid})`;
  if (!(await isListening(d, info.socket))) {
    const silent = judgeSilent(d, dir, info);
    if (silent.kind === 'starting') {
      out(`${info.version} (pid ${silent.holder})  ${notStopped}`);
      return;
    }
    out(`${info.version}  pid ${info.pid}  not running`);
    return;
  }
  const answered = await callOnce<Record<string, never>>(d, info.socket, 'daemon.shutdown');
  if (answered === undefined) {
    // daemon.json can be stale (pid reused, or a new daemon on this socket has
    // not rewritten it yet): signal only the pid the lock confirms.
    const { holder } = readLock(d, dir);
    if (holder !== info.pid || !d.isAlive(holder)) {
      err(
        `daemon ${label} did not answer; not signalling pid ${info.pid} ` +
          `(lock names ${holder ?? 'none'})`,
      );
      return;
    }
    try {
      d.kill(info.pid, 'SIGTERM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      err(`could not signal daemon ${label}: ${message}`);
      return;
    }
  }
  if (await waitGone(d, path.join(dir, 'daemon.json'))) {
    out(`stopped ${label}`);
  } else {
    err(`${info.version}  pid ${info.pid}  still running after ${STOP_WAIT_MS / 1000} s`);
  }
}

/**
 * Stop every alive daemon; report every starting one, which it cannot stop
 * yet. Stale entries are left for `status` to sweep. `no daemon known` when
 * there was nothing to report.
 */
export async function runStop(d: AdminDeps): Promise<number> {
  const { out, err, reported } = reporter(d);
  await forEachEntry(d, err, async (entry) => {
    if (entry.kind === 'starting') out(`${entry.name}  ${notStopped}`);
    if (entry.kind === 'valid') await stopOne(d, entry.dir, entry.info, out, err);
  });
  if (reported() === 0) out('no daemon known');
  return 0;
}
