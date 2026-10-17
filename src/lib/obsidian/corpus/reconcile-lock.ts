import { randomUUID } from 'node:crypto';
import {
  readFile as fsReadFile,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureCorpusDir, type MkdirFn } from './ensure-dir.js';
import { hasErrnoCode } from './errno.js';
import { LOCK_FILE } from './layout.js';

export const LOCK_POLL_MIN_MS = 50;
export const LOCK_POLL_MAX_MS = 2_000;
/**
 * About three times the measured default-profile cold index of a ~950-note
 * vault (7.9–8.8 min), which a holder may also spend part of downloading its
 * model on a first run (design D5).
 */
export const LOCK_MAX_WAIT_MS = 1_800_000;
/** How long an unparseable lock counts as "being written" before it counts as stale. */
export const LOCK_UNREADABLE_GRACE_MS = 1_000;

export interface CorpusLock {
  /** Removes the lock if it still holds exactly what this acquisition wrote. Never throws. */
  release(): Promise<void>;
}

/** Who a lock file names. `host` is null for a lock written without one (read as this host). */
export interface LockHolder {
  pid: number;
  host: string | null;
}

export interface CorpusLockDeps {
  /** Defaults to `process.pid`. */
  pid?: number;
  /** Defaults to `os.hostname()`. */
  host?: string;
  /** Unique per acquisition; defaults to `randomUUID()`. */
  token?: string;
  /** Defaults to {@link isProcessAlive}. Only ever asked about a pid on this host. */
  isAlive?: (pid: number) => boolean;
  /** Creates the file only if absent, rejecting with `EEXIST` otherwise. */
  createExclusive?: (p: string, data: string) => Promise<void>;
  readFile?: (p: string) => Promise<string>;
  unlink?: (p: string) => Promise<void>;
  mkdir?: MkdirFn;
  /** Must reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Defaults to {@link LOCK_MAX_WAIT_MS}. */
  maxWaitMs?: number;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called once, when a live holder is first seen; both fields are null while its content is unreadable. */
  onWait?: (wait: { holderPid: number | null; holderHost: string | null }) => void;
}

/**
 * The lock stayed held for the whole bound. `holderPid`/`holderHost` name the
 * last holder seen; several may have taken turns during `waitedMs`.
 */
export class CorpusLockTimeoutError extends Error {
  constructor(
    readonly lockFile: string,
    readonly holderPid: number | null,
    readonly waitedMs: number,
    readonly holderHost: string | null = null,
  ) {
    super(
      `neuro-vault corpus: waited ${Math.round(waitedMs / 1000)} s for ${lockFile} ` +
        `(last held by ${describeHolder(holderPid, holderHost)}) — giving up this pass ` +
        `(delete the file if that process is not a neuro-vault server or index run)`,
    );
    this.name = 'CorpusLockTimeoutError';
  }
}

/** `pid 42 on host-a`, `pid 42`, or `an unknown process` — for messages. */
export function describeHolder(pid: number | null, host: string | null): string {
  if (pid === null) return 'an unknown process';
  return host === null ? `pid ${pid}` : `pid ${pid} on ${host}`;
}

/** `kill(pid, 0)`: `ESRCH` means no such process; `EPERM` means it exists under another user. */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal: 0) => void = (p, s) => {
    process.kill(p, s);
  },
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return !hasErrnoCode(err, 'ESRCH');
  }
}

/**
 * Takes the vault's reconcile lock, waiting for a live holder (design D5).
 *
 * The lock is a file created exclusively with this host's name, the pid and a
 * token unique to the acquisition. A holder on another host — another machine,
 * or another container's pid namespace — is always live: `kill(pid, 0)` says
 * nothing about it here. On this host, a holder whose pid is not running, or
 * is this process's own (passes over one vault never overlap within a process,
 * so that is a dead predecessor's pid), is stale and replaced — only if the
 * file still holds what was judged stale. A file whose content does not parse
 * is treated as being written for {@link LOCK_UNREADABLE_GRACE_MS}, then as
 * stale. A live holder is polled with a doubling backoff
 * ({@link LOCK_POLL_MIN_MS}..{@link LOCK_POLL_MAX_MS}) for at most `maxWaitMs`,
 * then {@link CorpusLockTimeoutError}. A path that exists but keeps reading as
 * absent (a dangling symlink) is retried once at once, then waited on the same
 * way. An abort rejects the wait and leaves the holder's lock alone.
 */
export async function acquireCorpusLock(
  corpusRoot: string,
  deps: CorpusLockDeps = {},
  opts: AcquireOptions = {},
): Promise<CorpusLock> {
  const pid = deps.pid ?? process.pid;
  const host = deps.host ?? hostname();
  const token = deps.token ?? randomUUID();
  const isAlive = deps.isAlive ?? ((p: number) => isProcessAlive(p));
  const createExclusive =
    deps.createExclusive ?? ((p: string, data: string) => fsWriteFile(p, data, { flag: 'wx' }));
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const unlink = deps.unlink ?? ((p: string) => fsUnlink(p));
  const sleep =
    deps.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const now = deps.now ?? (() => Date.now());
  const maxWaitMs = deps.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const lockFile = path.join(corpusRoot, LOCK_FILE);
  // `<vault>/.neuro-vault/corpus`: never creates the vault root itself.
  await ensureCorpusDir(path.dirname(corpusRoot), corpusRoot, deps.mkdir);
  const content = `${JSON.stringify({ host, pid, token, acquired: new Date(now()).toISOString() })}\n`;
  const started = now();
  let pause = LOCK_POLL_MIN_MS;
  let announced = false;
  let unreadableSince: number | null = null;
  // An existing path that reads as absent (a dangling symlink) would otherwise spin.
  let vanishedInARow = 0;

  const waitOrGiveUp = async (holderPid: number | null, holderHost: string | null) => {
    const waited = now() - started;
    if (waited >= maxWaitMs) {
      throw new CorpusLockTimeoutError(lockFile, holderPid, waited, holderHost);
    }
    await sleep(pause, opts.signal);
    pause = Math.min(pause * 2, LOCK_POLL_MAX_MS);
  };

  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      await createExclusive(lockFile, content);
      return { release: () => releaseLock(lockFile, content, readFile, unlink, warn) };
    } catch (err) {
      if (!hasErrnoCode(err, 'EEXIST')) throw err;
    }

    const raw = await readOrNull(readFile, lockFile);
    if (raw === null) {
      // Whatever is created next is a new file: its grace starts when we see it.
      unreadableSince = null;
      // Released between our create and our read: try again at once — but a
      // path that keeps reading as absent is waited on like a live holder.
      if (++vanishedInARow > 1) await waitOrGiveUp(null, null);
      continue;
    }
    vanishedInARow = 0;

    const holder = parseHolder(raw);
    let stale: boolean;
    if (holder === null) {
      unreadableSince ??= now();
      stale = now() - unreadableSince >= LOCK_UNREADABLE_GRACE_MS;
    } else {
      unreadableSince = null;
      const sameHost = holder.host === null || holder.host === host;
      stale = sameHost && (holder.pid === pid || !isAlive(holder.pid));
    }
    if (stale) {
      await removeIfUnchanged(readFile, unlink, lockFile, raw);
      unreadableSince = null;
      continue;
    }

    const holderPid = holder?.pid ?? null;
    const holderHost = holder?.host ?? null;
    if (!announced) {
      announced = true;
      opts.onWait?.({ holderPid, holderHost });
    }
    await waitOrGiveUp(holderPid, holderHost);
  }
}

async function releaseLock(
  lockFile: string,
  content: string,
  readFile: (p: string) => Promise<string>,
  unlink: (p: string) => Promise<void>,
  warn: (message: string) => void,
): Promise<void> {
  try {
    // Exactly what this acquisition wrote, token included: anything else is
    // another holder's lock, even one with this process's pid.
    if ((await readOrNull(readFile, lockFile)) !== content) return;
    await unlink(lockFile);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return;
    warn(`neuro-vault corpus: failed to release ${lockFile}: ${String(err)}`);
  }
}

/** Unlinks only if the file still holds exactly what was judged stale. */
async function removeIfUnchanged(
  readFile: (p: string) => Promise<string>,
  unlink: (p: string) => Promise<void>,
  lockFile: string,
  judged: string,
): Promise<void> {
  const current = await readOrNull(readFile, lockFile);
  if (current !== judged) return;
  try {
    await unlink(lockFile);
  } catch (err) {
    if (!hasErrnoCode(err, 'ENOENT')) throw err;
  }
}

async function readOrNull(
  readFile: (p: string) => Promise<string>,
  file: string,
): Promise<string | null> {
  try {
    return await readFile(file);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }
}

function parseHolder(raw: string): LockHolder | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { pid, host } = parsed as { pid?: unknown; host?: unknown };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return { pid, host: typeof host === 'string' ? host : null };
}
