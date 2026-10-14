import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireLock,
  defaultLockFs,
  isPidAlive,
  releaseLock,
  type LockFs,
  type LockResult,
} from '../../src/daemon/lock.js';

const LOCK = '/s/daemon.lock';

type Op = 'openExclusive' | 'read' | 'rename' | 'unlink' | 'linkExclusive';

interface MemHooks {
  /** Runs before the named op touches the map; may mutate it to simulate another starter. */
  beforeOp?: (op: Op, file: string) => void;
}

function memFs(
  initial: Record<string, string> = {},
  hooks: MemHooks = {},
): LockFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  const before = (op: Op, file: string) => hooks.beforeOp?.(op, file);
  return {
    files,
    mkdirp: () => {},
    openExclusive: (file, content) => {
      before('openExclusive', file);
      if (files.has(file)) return false;
      files.set(file, content);
      return true;
    },
    read: (file) => {
      before('read', file);
      return files.get(file);
    },
    unlink: (file) => {
      before('unlink', file);
      files.delete(file);
    },
    rename: (from, to) => {
      before('rename', from);
      const content = files.get(from);
      if (content === undefined) return false;
      files.delete(from);
      files.set(to, content);
      return true;
    },
    linkExclusive: (existing, newPath) => {
      before('linkExclusive', newPath);
      const content = files.get(existing);
      if (content === undefined) throw new Error(`ENOENT: ${existing}`);
      if (files.has(newPath)) return false;
      files.set(newPath, content);
      return true;
    },
  };
}

/**
 * Two starters both judge the same dead holder (pid 7). The `outer` starter
 * pauses right before its first rename of the lock; the `inner` starter runs to
 * completion inside that gap, then the outer proceeds with its stale verdict.
 */
function raceOnDeadHolder(
  outerPid: number,
  innerPid: number,
): { outer: LockResult; inner: LockResult; files: Map<string, string> } {
  let innerDone = false;
  let inner: LockResult = { kind: 'contended' };
  const fs = memFs(
    { [LOCK]: '7' },
    {
      beforeOp: (op, file) => {
        if (op !== 'rename' || file !== LOCK || innerDone) return;
        innerDone = true;
        inner = acquireLock(LOCK, { pid: innerPid, isAlive: (pid) => pid !== 7, fs });
      },
    },
  );
  const outer = acquireLock(LOCK, { pid: outerPid, isAlive: (pid) => pid !== 7, fs });
  return { outer, inner, files: fs.files };
}

describe('acquireLock', () => {
  it('creates the lock with its pid when none exists', () => {
    const fs = memFs();
    expect(acquireLock(LOCK, { pid: 42, isAlive: () => true, fs })).toEqual({ kind: 'acquired' });
    expect(fs.files.get(LOCK)).toBe('42');
  });

  it('refuses when the holder is alive', () => {
    const fs = memFs({ [LOCK]: '7' });
    expect(acquireLock(LOCK, { pid: 42, isAlive: (pid) => pid === 7, fs })).toEqual({
      kind: 'held',
      pid: 7,
    });
    expect(fs.files.get(LOCK)).toBe('7');
  });

  it('replaces a dead holder and leaves no stale file behind', () => {
    const fs = memFs({ [LOCK]: '7' });
    expect(acquireLock(LOCK, { pid: 42, isAlive: () => false, fs })).toEqual({ kind: 'acquired' });
    expect(fs.files.get(LOCK)).toBe('42');
    expect([...fs.files.keys()]).toEqual([LOCK]);
  });

  it('treats an unreadable pid as dead', () => {
    const fs = memFs({ [LOCK]: 'garbage' });
    expect(acquireLock(LOCK, { pid: 42, isAlive: () => true, fs })).toEqual({ kind: 'acquired' });
  });

  it("treats a pid with trailing junk ('7abc') as dead, not as pid 7", () => {
    const fs = memFs({ [LOCK]: '7abc' });
    expect(acquireLock(LOCK, { pid: 42, isAlive: () => true, fs })).toEqual({ kind: 'acquired' });
    expect(fs.files.get(LOCK)).toBe('42');
  });

  it('I1: when the other starter completes inside our stale-verdict gap, only it acquires', () => {
    // Inner = pid 42 acquires; outer = pid 43 still holds its stale verdict on pid 7.
    const { outer, inner, files } = raceOnDeadHolder(43, 42);
    expect(inner).toEqual({ kind: 'acquired' });
    expect(outer).toEqual({ kind: 'held', pid: 42 });
    expect(files.get(LOCK)).toBe('42');
  });

  it('I1 mirror: the outer starter acquires and the inner one is told it is held', () => {
    const { outer, inner, files } = raceOnDeadHolder(42, 43);
    expect(outer).toEqual({ kind: 'held', pid: 43 });
    expect(inner).toEqual({ kind: 'acquired' });
    expect(files.get(LOCK)).toBe('43');
  });

  it('restores a fresh lock that was moved aside by mistake and reports its holder', () => {
    let published = false;
    const fs: LockFs & { files: Map<string, string> } = memFs(
      { [LOCK]: '7' },
      {
        beforeOp: (op) => {
          if (op !== 'rename' || published) return;
          published = true;
          // Another starter publishes a live lock between our read and our rename.
          fs.files.set(LOCK, '42');
        },
      },
    );
    expect(acquireLock(LOCK, { pid: 43, isAlive: () => false, fs })).toEqual({
      kind: 'held',
      pid: 42,
    });
    expect(fs.files.get(LOCK)).toBe('42');
    expect([...fs.files.keys()]).toEqual([LOCK]);
  });

  it('contended when the lock moved aside names no holder', () => {
    let published = false;
    const fs: LockFs & { files: Map<string, string> } = memFs(
      { [LOCK]: '7' },
      {
        beforeOp: (op) => {
          if (op !== 'rename' || published) return;
          published = true;
          fs.files.set(LOCK, 'garbage');
        },
      },
    );
    expect(acquireLock(LOCK, { pid: 43, isAlive: () => false, fs })).toEqual({
      kind: 'contended',
    });
  });

  it('contended when retries run out', () => {
    const never: LockFs = {
      mkdirp: () => {},
      openExclusive: () => false,
      read: () => undefined,
      unlink: () => {},
      rename: () => false,
      linkExclusive: () => false,
    };
    expect(acquireLock(LOCK, { pid: 42, isAlive: () => true, fs: never })).toEqual({
      kind: 'contended',
    });
  });
});

describe('releaseLock', () => {
  it('removes a lock that names our pid (trailing newline tolerated)', () => {
    const fs = memFs({ [LOCK]: '42\n' });
    releaseLock(LOCK, fs, 42);
    expect(fs.files.has(LOCK)).toBe(false);
  });

  it('leaves a lock that names another pid in place', () => {
    const fs = memFs({ [LOCK]: '43' });
    releaseLock(LOCK, fs, 42);
    expect(fs.files.get(LOCK)).toBe('43');
  });
});

describe('isPidAlive', () => {
  it('reports this process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('defaultLockFs', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'nv-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exclusive-creates once, reads back the content, and tolerates unlink of a missing file', () => {
    const lockFs = defaultLockFs();
    const file = path.join(dir, 'daemon.lock');
    expect(lockFs.openExclusive(file, '123')).toBe(true);
    expect(lockFs.openExclusive(file, '456')).toBe(false);
    expect(lockFs.read(file)).toBe('123');
    lockFs.unlink(file);
    expect(lockFs.read(file)).toBeUndefined();
    expect(() => lockFs.unlink(file)).not.toThrow();
  });

  it('publishes without leaving temp files behind and writes the lock as 0600', () => {
    const lockFs = defaultLockFs();
    const file = path.join(dir, 'daemon.lock');
    expect(lockFs.openExclusive(file, '123')).toBe(true);
    expect(lockFs.openExclusive(file, '456')).toBe(false);
    expect(readdirSync(dir)).toEqual(['daemon.lock']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
