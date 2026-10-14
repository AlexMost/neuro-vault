import fs from 'node:fs';
import path from 'node:path';

export interface LockFs {
  mkdirp(dir: string): void;
  /** Exclusive create (`wx`); false when the file already exists. */
  openExclusive(file: string, content: string): boolean;
  read(file: string): string | undefined;
  unlink(file: string): void;
}

export function defaultLockFs(): LockFs {
  return {
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true, mode: 0o700 }),
    openExclusive: (file, content) => {
      try {
        fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    read: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    unlink: (file) => {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = { kind: 'acquired' } | { kind: 'held'; pid: number };

/**
 * Exclusive-create under the state dir. An existing lock is only ever
 * replaced when its holder is dead; two starters racing on `wx` cannot both
 * win, which is what keeps the stale-socket cleanup (probe.ts) safe.
 */
export function acquireLock(
  lockFile: string,
  deps: { pid: number; isAlive: (pid: number) => boolean; fs: LockFs },
): LockResult {
  deps.fs.mkdirp(path.dirname(lockFile));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (deps.fs.openExclusive(lockFile, String(deps.pid))) return { kind: 'acquired' };
    const holder = Number.parseInt(deps.fs.read(lockFile) ?? '', 10);
    if (Number.isInteger(holder) && holder > 0 && deps.isAlive(holder)) {
      return { kind: 'held', pid: holder };
    }
    deps.fs.unlink(lockFile);
  }
  return { kind: 'held', pid: -1 };
}

export function releaseLock(lockFile: string, lockFs: LockFs): void {
  lockFs.unlink(lockFile);
}
