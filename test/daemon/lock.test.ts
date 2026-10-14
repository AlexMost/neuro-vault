import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, defaultLockFs, releaseLock, type LockFs } from '../../src/daemon/lock.js';

function memFs(initial: Record<string, string> = {}): LockFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    mkdirp: () => {},
    openExclusive: (file, content) => {
      if (files.has(file)) return false;
      files.set(file, content);
      return true;
    },
    read: (file) => files.get(file),
    unlink: (file) => {
      files.delete(file);
    },
  };
}

describe('acquireLock', () => {
  it('creates the lock with its pid when none exists', () => {
    const fs = memFs();
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => true, fs })).toEqual({
      kind: 'acquired',
    });
    expect(fs.files.get('/s/daemon.lock')).toBe('42');
  });
  it('refuses when the holder is alive', () => {
    const fs = memFs({ '/s/daemon.lock': '7' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: (pid) => pid === 7, fs })).toEqual({
      kind: 'held',
      pid: 7,
    });
    expect(fs.files.get('/s/daemon.lock')).toBe('7');
  });
  it('replaces a dead holder', () => {
    const fs = memFs({ '/s/daemon.lock': '7' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => false, fs })).toEqual({
      kind: 'acquired',
    });
    expect(fs.files.get('/s/daemon.lock')).toBe('42');
  });
  it('treats an unreadable pid as dead', () => {
    const fs = memFs({ '/s/daemon.lock': 'garbage' });
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => true, fs })).toEqual({
      kind: 'acquired',
    });
  });
  it('releaseLock removes the file', () => {
    const fs = memFs({ '/s/daemon.lock': '42' });
    releaseLock('/s/daemon.lock', fs);
    expect(fs.files.has('/s/daemon.lock')).toBe(false);
  });
  it('second create loses the wx race while the first holder is alive', () => {
    const fs = memFs();
    expect(acquireLock('/s/daemon.lock', { pid: 42, isAlive: () => true, fs })).toEqual({
      kind: 'acquired',
    });
    expect(acquireLock('/s/daemon.lock', { pid: 43, isAlive: () => true, fs })).toEqual({
      kind: 'held',
      pid: 42,
    });
    expect(fs.files.get('/s/daemon.lock')).toBe('42');
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
});
