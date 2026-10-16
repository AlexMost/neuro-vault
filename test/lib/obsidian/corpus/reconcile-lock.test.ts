import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { LOCK_FILE } from '../../../../src/lib/obsidian/corpus/layout.js';
import {
  acquireCorpusLock,
  CorpusLockTimeoutError,
  isProcessAlive,
  LOCK_MAX_WAIT_MS,
} from '../../../../src/lib/obsidian/corpus/reconcile-lock.js';

const ME = 1001;
const HOLDER = 4242;
const HERE = 'here.local';
/** This process's identity in every test: a fixed pid and host. */
const SELF = { pid: ME, host: HERE };

async function corpusDir(): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), 'nv-lock-')), '.neuro-vault/corpus');
}

async function writeLock(dir: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  await writeFile(file, content);
  return file;
}

const holderContent = (pid: number, host = HERE, token = 'theirs') =>
  JSON.stringify({ host, pid, token, acquired: 'x' });

/** A fake clock whose sleeps advance it; `onSleep` runs after each sleep is recorded. */
function fakeClock(onSleep: (count: number) => Promise<void> | void = () => {}) {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
      await onSleep(sleeps.length);
    },
  };
}

const errno = (code: string) => Object.assign(new Error(code), { code });

/**
 * An in-memory lock file: `content` null means absent. `createExclusive`
 * rejects with EEXIST while it exists; `unlinked` records what each unlink removed.
 */
function fakeLockFile(initial: string | null) {
  const state = { content: initial, unlinked: [] as string[] };
  return {
    state,
    createExclusive: async (_p: string, data: string) => {
      if (state.content !== null) throw errno('EEXIST');
      state.content = data;
    },
    readFile: async () => {
      if (state.content === null) throw errno('ENOENT');
      return state.content;
    },
    unlink: async () => {
      if (state.content === null) throw errno('ENOENT');
      state.unlinked.push(state.content);
      state.content = null;
    },
  };
}

const gone = async (p: string) =>
  stat(p).then(
    () => false,
    () => true,
  );

describe('acquireCorpusLock', () => {
  it('creates the corpus root if needed and records host, pid and token', async () => {
    const dir = await corpusDir();
    const lock = await acquireCorpusLock(dir, { ...SELF, token: 'mine' });
    expect(JSON.parse(await readFile(path.join(dir, LOCK_FILE), 'utf8'))).toMatchObject({
      host: HERE,
      pid: ME,
      token: 'mine',
    });
    await lock.release();
    expect(await gone(path.join(dir, LOCK_FILE))).toBe(true);
  });

  it('bounds the wait at 30 minutes by default', () => {
    expect(LOCK_MAX_WAIT_MS).toBe(30 * 60 * 1000);
  });

  it('release leaves a lock that now holds another acquisition, even one with its own pid', async () => {
    const dir = await corpusDir();
    const lock = await acquireCorpusLock(dir, { ...SELF, token: 'mine' });
    const file = await writeLock(dir, holderContent(ME, HERE, 'someone-else'));
    await lock.release();
    expect(await readFile(file, 'utf8')).toBe(holderContent(ME, HERE, 'someone-else'));
  });

  it('replaces a dead holder on this host without sleeping', async () => {
    const dir = await corpusDir();
    await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock();
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { ...SELF, isAlive: () => false, ...clock },
      { onWait },
    );
    expect(clock.sleeps).toEqual([]);
    expect(onWait).not.toHaveBeenCalled();
    await lock.release();
  });

  it('replaces a lock naming its own pid on its own host — a dead predecessor’s leftover', async () => {
    const dir = await corpusDir();
    await writeLock(dir, holderContent(ME));
    const clock = fakeClock();
    const lock = await acquireCorpusLock(dir, { ...SELF, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([]);
    await lock.release();
  });

  it('never takes over a holder on another host, even when its pid is not running here', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(ME, 'container-b')); // even our own pid
    const isAlive = vi.fn(() => false);
    const clock = fakeClock(async (count) => {
      if (count === 2) await rm(file);
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(dir, { ...SELF, isAlive, ...clock }, { onWait });
    expect(clock.sleeps).toEqual([50, 100]);
    expect(isAlive).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenCalledWith({ holderPid: ME, holderHost: 'container-b' });
    await lock.release();
  });

  it('reads a lock without a host as this host’s', async () => {
    const dir = await corpusDir();
    await writeLock(dir, JSON.stringify({ pid: HOLDER, acquired: 'x' }));
    const clock = fakeClock();
    const lock = await acquireCorpusLock(dir, { ...SELF, isAlive: () => false, ...clock });
    expect(clock.sleeps).toEqual([]);
    await lock.release();
  });

  it('waits for a live holder with a doubling backoff, announcing it once', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock(async (count) => {
      if (count === 3) await rm(file);
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { ...SELF, isAlive: () => true, ...clock },
      { onWait },
    );
    expect(clock.sleeps).toEqual([50, 100, 200]);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith({ holderPid: HOLDER, holderHost: HERE });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: ME });
    await lock.release();
  });

  it('caps the backoff at 2 s', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock(async (count) => {
      if (count === 9) await rm(file);
    });
    const lock = await acquireCorpusLock(dir, { ...SELF, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800, 1600, 2000, 2000, 2000]);
    await lock.release();
  });

  it('gives up after the bound, naming the lock file, host and holder, leaving its lock', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const clock = fakeClock();
    const err = await acquireCorpusLock(dir, {
      ...SELF,
      isAlive: () => true,
      maxWaitMs: 1_000,
      ...clock,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorpusLockTimeoutError);
    expect(err).toMatchObject({ lockFile: file, holderPid: HOLDER, holderHost: HERE });
    expect((err as Error).message).toContain(LOCK_FILE);
    expect((err as Error).message).toBe(
      `neuro-vault corpus: waited 2 s for ${file} (last held by pid ${HOLDER} on ${HERE}) — ` +
        'giving up this pass (delete the file if that process is not a neuro-vault server ' +
        'or index run)',
    );
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800]);
    expect(await readFile(file, 'utf8')).toBe(holderContent(HOLDER));
  });

  it('treats a lock caught mid-create as held, never deleting it', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, ''); // created by `wx`, not yet written
    const unlink = vi.fn(async (p: string) => rm(p));
    const clock = fakeClock(async (count) => {
      if (count === 1) await writeFile(file, holderContent(HOLDER)); // the holder finishes its write
      if (count === 3) await rm(file); // ...and later releases
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      dir,
      { ...SELF, isAlive: () => true, unlink, ...clock },
      { onWait },
    );
    expect(unlink).not.toHaveBeenCalled();
    expect(onWait).toHaveBeenCalledWith({ holderPid: null, holderHost: null });
    await lock.release();
  });

  it('replaces a lock whose content stays unparseable past the 1 s grace', async () => {
    const dir = await corpusDir();
    await writeLock(dir, 'garbage');
    const clock = fakeClock();
    const lock = await acquireCorpusLock(dir, { ...SELF, isAlive: () => true, ...clock });
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800]); // 1550 ms ≥ 1000 ms grace
    await lock.release();
  });

  it('times the grace afresh for a new unparseable lock caught after a stale removal', async () => {
    const lockFile = fakeLockFile('garbage');
    let replacedAt = -1;
    const unlink = async () => {
      await lockFile.unlink();
      if (replacedAt < 0) {
        // Another process creates the lock right after the removal, not yet written.
        lockFile.state.content = '';
        replacedAt = clock.sleeps.length;
      }
    };
    const clock = fakeClock((count) => {
      if (replacedAt < 0) return;
      if (count === replacedAt + 1) lockFile.state.content = holderContent(HOLDER);
      if (count === replacedAt + 2) lockFile.state.content = null;
    });
    const lock = await acquireCorpusLock('/vault/.neuro-vault/corpus', {
      ...SELF,
      isAlive: () => true,
      mkdir: async () => {},
      ...lockFile,
      unlink,
      ...clock,
    });
    expect(lockFile.state.unlinked).toEqual(['garbage']);
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800, 1600, 2000]);
    await lock.release();
  });

  it('times the grace afresh for an unparseable lock seen after the file vanished', async () => {
    const lockFile = fakeLockFile('garbage');
    let vanishing = false;
    let vanishedAt = -1;
    const createExclusive = async (p: string, data: string) => {
      // The old file is gone and a racing create wins: our create fails, our read misses.
      if (vanishing) throw errno('EEXIST');
      await lockFile.createExclusive(p, data);
    };
    const readFile = async () => {
      if (vanishing) {
        vanishing = false;
        lockFile.state.content = ''; // the racer's file, not yet written
        throw errno('ENOENT');
      }
      return lockFile.readFile();
    };
    const clock = fakeClock((count) => {
      if (count === 4) {
        lockFile.state.content = null;
        vanishing = true;
        vanishedAt = count;
      }
      if (vanishedAt < 0) return;
      if (count === vanishedAt + 2) lockFile.state.content = holderContent(HOLDER);
      if (count === vanishedAt + 3) lockFile.state.content = null;
    });
    const lock = await acquireCorpusLock('/vault/.neuro-vault/corpus', {
      ...SELF,
      isAlive: () => true,
      mkdir: async () => {},
      ...lockFile,
      createExclusive,
      readFile,
      ...clock,
    });
    expect(lockFile.state.unlinked).toEqual([]);
    await lock.release();
  });

  it('leaves a stale-judged lock alone when it changed before the unlink, and waits on the new holder', async () => {
    const LIVE = 777;
    const lockFile = fakeLockFile(holderContent(HOLDER, HERE, 'dead'));
    let reads = 0;
    const readFile = async () => {
      const content = await lockFile.readFile();
      // Between the judging read and the re-read, the dead holder's lock is
      // replaced by a live process's.
      if (++reads === 1) lockFile.state.content = holderContent(LIVE, HERE, 'live');
      return content;
    };
    const clock = fakeClock((count) => {
      if (count === 1) lockFile.state.content = null; // the live holder releases
    });
    const onWait = vi.fn();
    const lock = await acquireCorpusLock(
      '/vault/.neuro-vault/corpus',
      {
        ...SELF,
        isAlive: (p) => p === LIVE,
        mkdir: async () => {},
        ...lockFile,
        readFile,
        ...clock,
      },
      { onWait },
    );
    expect(lockFile.state.unlinked).toEqual([]);
    expect(onWait).toHaveBeenCalledWith({ holderPid: LIVE, holderHost: HERE });
    expect(clock.sleeps).toEqual([50]);
    await lock.release();
  });

  it('bounds and backs off a lock path that exists but cannot be read (a dangling symlink)', async () => {
    let reads = 0;
    const clock = fakeClock();
    const err = await acquireCorpusLock('/vault/.neuro-vault/corpus', {
      ...SELF,
      mkdir: async () => {},
      createExclusive: async () => {
        throw errno('EEXIST');
      },
      readFile: async () => {
        // A spinning loop never yields to timers; fail loudly instead of hanging.
        if (++reads > 1_000) throw new Error('spinning without sleeping');
        throw errno('ENOENT');
      },
      maxWaitMs: 1_000,
      ...clock,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorpusLockTimeoutError);
    expect(err).toMatchObject({ holderPid: null, holderHost: null });
    expect(clock.sleeps).toEqual([50, 100, 200, 400, 800]);
  });

  it('stops waiting when aborted, leaving the holder’s lock', async () => {
    const dir = await corpusDir();
    const file = await writeLock(dir, holderContent(HOLDER));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    // The default sleep: proves the real timer honours the signal.
    await expect(
      acquireCorpusLock(dir, { ...SELF, isAlive: () => true }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(holderContent(HOLDER));
  });

  it('propagates a create failure other than EEXIST', async () => {
    const dir = await corpusDir();
    const denied = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    await expect(
      acquireCorpusLock(dir, {
        ...SELF,
        createExclusive: async () => {
          throw denied;
        },
      }),
    ).rejects.toBe(denied);
  });
});

describe('CorpusLock.release', () => {
  async function acquired(overrides: {
    readFile?: () => Promise<string>;
    unlink?: () => Promise<void>;
  }) {
    const lockFile = fakeLockFile(null);
    const warn = vi.fn();
    const lock = await acquireCorpusLock('/vault/.neuro-vault/corpus', {
      ...SELF,
      mkdir: async () => {},
      ...lockFile,
      ...overrides,
      warn,
    });
    return { lock, warn };
  }

  it('warns once, naming the lock file, and resolves when the unlink fails', async () => {
    const { lock, warn } = await acquired({
      unlink: async () => {
        throw errno('EACCES');
      },
    });
    await expect(lock.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(path.join('/vault/.neuro-vault/corpus', LOCK_FILE));
  });

  it('warns once, naming the lock file, and resolves when the read fails', async () => {
    const { lock, warn } = await acquired({
      readFile: async () => {
        throw errno('EIO');
      },
    });
    await expect(lock.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(path.join('/vault/.neuro-vault/corpus', LOCK_FILE));
  });
});

describe('isProcessAlive', () => {
  const throwing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it('reads ESRCH as dead and EPERM as alive', () => {
    expect(isProcessAlive(HOLDER, throwing('ESRCH'))).toBe(false);
    expect(isProcessAlive(HOLDER, throwing('EPERM'))).toBe(true);
    expect(isProcessAlive(HOLDER, () => {})).toBe(true);
  });

  it('sees this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe('acquireCorpusLock on a vault root that no longer exists', () => {
  it('rejects with ENOENT and does not recreate the vault', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-lock-gone-'));
    await rm(root, { recursive: true, force: true });

    await expect(
      acquireCorpusLock(path.join(root, '.neuro-vault/corpus'), SELF),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates .neuro-vault/corpus under a vault that exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-lock-here-'));
    const lock = await acquireCorpusLock(path.join(root, '.neuro-vault/corpus'), SELF);
    expect((await stat(path.join(root, '.neuro-vault/corpus', LOCK_FILE))).isFile()).toBe(true);
    await lock.release();
  });
});
