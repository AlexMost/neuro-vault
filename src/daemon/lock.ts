import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface LockFs {
  mkdirp(dir: string): void;
  /**
   * Publish `content` at `file` only if nothing is there; false when it exists.
   * A reader never observes a partly written file.
   */
  openExclusive(file: string, content: string): boolean;
  /** Content of `file`, or undefined when it does not exist. */
  read(file: string): string | undefined;
  unlink(file: string): void;
  /** Atomic move; false when `from` does not exist. Overwrites `to`. */
  rename(from: string, to: string): boolean;
  /** Hard-link `existing` to `newPath`; false when `newPath` already exists. */
  linkExclusive(existing: string, newPath: string): boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function unlinkFile(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

export function defaultLockFs(): LockFs {
  return {
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
    openExclusive: (file, content) => {
      // Write the full content to a private temp file, then hard-link it into
      // place: link(2) fails with EEXIST if the lock exists, and the lock is
      // never visible half-written.
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
        try {
          fs.linkSync(tmp, file);
          return true;
        } catch (error) {
          if (errorCode(error) === 'EEXIST') return false;
          throw error;
        }
      } finally {
        unlinkFile(tmp);
      }
    },
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    },
    unlink: unlinkFile,
    rename: (from, to) => {
      try {
        fs.renameSync(from, to);
        return true;
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
      }
    },
    linkExclusive: (existing, newPath) => {
      try {
        fs.linkSync(existing, newPath);
        return true;
      } catch (error) {
        if (errorCode(error) === 'EEXIST') return false;
        throw error;
      }
    },
  };
}

/** `kill(pid, 0)`: EPERM means "exists, not ours" — alive for our purposes. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export type LockResult =
  | { kind: 'acquired' }
  | { kind: 'held'; pid: number }
  /** Retries ran out, or the lock names no usable holder. The caller should back off. */
  | { kind: 'contended' };

const MAX_ATTEMPTS = 3;

/** A holder pid is a positive decimal integer; anything else names no holder. */
function parseHolder(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const pid = Number(text);
  return pid > 0 ? pid : undefined;
}

/**
 * Take the lock file at `lockFile`, recording our pid in it.
 *
 * Guarantees: publishing is atomic (a reader sees no file or the complete pid),
 * and while the file exists only the holder it names can be reported `held`.
 * A lock is replaced only when its holder is dead or names no pid. Replacement
 * first renames the lock to a private path and checks what it actually moved;
 * a live lock moved by mistake is restored with a hard link.
 *
 * Not guaranteed: if another starter takes the slot in the window between that
 * mistaken move and the restore, the moved holder's lock is dropped rather than
 * restored. A starter that loses that window can report `acquired` while the
 * other starter believes it holds the lock. The real holder's pid in the file is
 * the source of truth for the rest of the daemon's lifecycle.
 */
export function acquireLock(
  lockFile: string,
  deps: { pid: number; isAlive: (pid: number) => boolean; fs: LockFs },
): LockResult {
  deps.fs.mkdirp(path.dirname(lockFile));
  const moved = `${lockFile}.stale.${deps.pid}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (deps.fs.openExclusive(lockFile, String(deps.pid))) return { kind: 'acquired' };
    const raw = deps.fs.read(lockFile);
    if (raw === undefined) continue; // released between our create and read: retry
    const holder = parseHolder(raw);
    if (holder !== undefined && deps.isAlive(holder)) return { kind: 'held', pid: holder };
    // Dead or unnamed holder: move the lock aside instead of unlinking it, so we
    // act on the file we inspected rather than whatever is there by now.
    if (!deps.fs.rename(lockFile, moved)) continue; // someone else moved it: retry
    const seized = deps.fs.read(moved);
    if (seized === undefined) continue;
    if (seized === raw) {
      // We moved exactly the dead lock we judged. Drop it and retry the create.
      deps.fs.unlink(moved);
      continue;
    }
    // We moved a lock published after our read. Put it back if the slot is still free.
    deps.fs.linkExclusive(moved, lockFile);
    deps.fs.unlink(moved);
    const seizedHolder = parseHolder(seized);
    return seizedHolder === undefined ? { kind: 'contended' } : { kind: 'held', pid: seizedHolder };
  }
  return { kind: 'contended' };
}

/**
 * Remove the lock only when it names `pid`. A lock naming another pid is left
 * alone. This is a read followed by an unlink, so it is not atomic: a starter
 * that judged our pid dead could replace the lock in between. Such a starter
 * only exists if it misjudges a live local holder as dead.
 */
export function releaseLock(lockFile: string, lockFs: LockFs, pid: number): void {
  const raw = lockFs.read(lockFile);
  if (raw !== undefined && raw.trim() === String(pid)) lockFs.unlink(lockFile);
}
