import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  reconcileProfile,
  withReconcileLock,
  type NoteContent,
  type IProfileReconcileDeps,
} from '../../../../src/lib/obsidian/corpus/reconcile.js';
import { ShardCorpus } from '../../../../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { TEST_DIMS, TEST_IDENTITY } from '../../../_identity.js';

const body = (marker: string) => `# ${marker}\n${'x'.repeat(300)}\n`;

/** In-memory vault: path -> note, with mtime/size the pass compares against its records. */
function fakeVault(files: Record<string, string>) {
  const state = new Map<string, NoteContent>(
    Object.entries(files).map(([p, content]) => [p, { content, mtime: 1, size: content.length }]),
  );
  const entry = (p: string) => {
    const found = state.get(p);
    if (!found) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return found;
  };
  return {
    paths: () => [...state.keys()].sort(),
    stat: async (p: string) => {
      const { mtime, size } = entry(p);
      return { mtime, size };
    },
    readNote: async (p: string) => ({ ...entry(p) }),
    edit: (p: string, content: string) => state.set(p, { content, mtime: 2, size: content.length }),
    touch: (p: string) => {
      const current = entry(p);
      state.set(p, { ...current, mtime: current.mtime + 1 });
    },
    move: (from: string, to: string) => {
      const current = entry(from);
      state.delete(from);
      state.set(to, current);
    },
    add: (p: string, content: string) => state.set(p, { content, mtime: 1, size: content.length }),
    remove: (p: string) => state.delete(p),
  };
}

async function harness(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-profile-'));
  const vault = fakeVault(files);
  const store = new ShardStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
  const corpus = new ShardCorpus(store, { yieldEvery: () => Promise.resolve() });
  const embed = vi.fn(async (texts: string[]) =>
    texts.map(() => new Array<number>(TEST_DIMS).fill(0.5)),
  );
  const warn = vi.fn();
  const deps: IProfileReconcileDeps = {
    vaultRoot: root,
    stat: vault.stat,
    readNote: vault.readNote,
    embedDocuments: embed,
    identity: TEST_IDENTITY,
    warn,
  };
  const run = () => reconcileProfile(deps, corpus, vault.paths(), {});
  // Mirrors what the caller does: identity first (reconcileProfile does it), then a load so
  // memory exists to be kept in step.
  await corpus.ensureIdentity(TEST_IDENTITY);
  await corpus.load();
  return { vault, store, corpus, embed, warn, run };
}

describe('reconcileProfile', () => {
  it('embeds a new note into memory and shards alike', async () => {
    const { run, corpus, store } = await harness({ 'A.md': body('A') });

    await run();

    const inMemory = await corpus.entries();
    const onDisk = await store.listShards();
    expect([...inMemory.keys()]).toEqual(['A.md']);
    expect([...onDisk.keys()]).toEqual(['A.md']);
    expect(inMemory.get('A.md')?.content_hash).toBe(onDisk.get('A.md')?.content_hash);
  });

  it('touch keeps vectors when only mtime changed', async () => {
    const { run, vault, corpus, embed } = await harness({ 'A.md': body('A') });
    await run();
    const vector = corpus.vectorOf('A.md');
    embed.mockClear();

    vault.touch('A.md');
    const summary = await run();

    expect(summary).toMatchObject({ reused: 1, embedded: 0, added: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(corpus.vectorOf('A.md')).toEqual(vector);
    expect((await corpus.entries()).get('A.md')?.mtime).toBe(2);
  });

  it('rename by hash upserts the new path and deletes the old', async () => {
    const { run, vault, corpus, store } = await harness({ 'Old.md': body('A') });
    await run();

    vault.move('Old.md', 'New.md');
    const summary = await run();

    expect(summary).toMatchObject({ renamed: 1, embedded: 0, added: 0, deleted: 0 });
    expect([...(await corpus.entries()).keys()]).toEqual(['New.md']);
    expect([...(await store.listShards()).keys()]).toEqual(['New.md']);
  });

  it('sweeps an orphan out of memory and disk', async () => {
    const { run, vault, corpus, store } = await harness({
      'A.md': body('A'),
      'B.md': body('B'),
    });
    await run();

    vault.remove('B.md');
    const summary = await run();

    expect(summary).toMatchObject({ deleted: 1 });
    expect([...(await corpus.entries()).keys()]).toEqual(['A.md']);
    expect([...(await store.listShards()).keys()]).toEqual(['A.md']);
  });

  it('counts added apart from changed', async () => {
    const { run, vault } = await harness({ 'A.md': body('A') });
    await run();

    vault.edit('A.md', body('A edited'));
    vault.add('B.md', body('B'));
    const summary = await run();

    expect(summary).toMatchObject({ total: 2, embedded: 2, added: 1 });
  });
});

describe('withReconcileLock', () => {
  it('reports waited when another holder had the lock', async () => {
    const release = vi.fn(async () => undefined);
    const onLockWait = vi.fn();
    const fn = vi.fn(async (ctx: { waited: boolean }) => ctx.waited);

    const result = await withReconcileLock(
      '/vault',
      {
        onLockWait,
        migrateLegacy: async () => undefined,
        acquireLock: async (opts) => {
          opts.onWait?.({ holderPid: 7, holderHost: null });
          return { release };
        },
      },
      fn,
    );

    expect(result).toBe(true);
    expect(onLockWait).toHaveBeenCalledWith({ holderPid: 7, holderHost: null });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('reports not waited when the lock was free', async () => {
    const result = await withReconcileLock(
      '/vault',
      {
        migrateLegacy: async () => undefined,
        acquireLock: async () => ({ release: async () => undefined }),
      },
      async (ctx) => ctx.waited,
    );
    expect(result).toBe(false);
  });

  it('resolves undefined without acquiring when already aborted', async () => {
    const acquireLock = vi.fn();
    const fn = vi.fn();

    const result = await withReconcileLock(
      '/vault',
      { signal: AbortSignal.abort(), acquireLock },
      fn,
    );

    expect(result).toBeUndefined();
    expect(acquireLock).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('warns rather than throws when onLockWait throws', async () => {
    const warn = vi.fn();
    const result = await withReconcileLock(
      '/vault',
      {
        warn,
        onLockWait: () => {
          throw new Error('boom');
        },
        migrateLegacy: async () => undefined,
        acquireLock: async (opts) => {
          opts.onWait?.({ holderPid: null, holderHost: null });
          return { release: async () => undefined };
        },
      },
      async () => 'ran',
    );
    expect(result).toBe('ran');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onLockWait callback threw'));
  });

  it('releases the lock when fn throws', async () => {
    const release = vi.fn(async () => undefined);
    await expect(
      withReconcileLock(
        '/vault',
        { migrateLegacy: async () => undefined, acquireLock: async () => ({ release }) },
        async () => {
          throw new Error('fn failed');
        },
      ),
    ).rejects.toThrow('fn failed');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
