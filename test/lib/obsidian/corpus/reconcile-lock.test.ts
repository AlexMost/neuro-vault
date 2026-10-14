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
    expect((err as Error).message).toContain(`pid ${HOLDER} on ${HERE}`);
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
