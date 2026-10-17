import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { corpusIdentityOf } from '../../../src/lib/obsidian/corpus/identity.js';
import type {
  ILockedPassOptions,
  withReconcileLock,
} from '../../../src/lib/obsidian/corpus/reconcile.js';
import { contentHash } from '../../../src/lib/obsidian/corpus/reconcile.js';
import { ShardCorpus } from '../../../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../../../src/lib/obsidian/corpus/shard-store.js';
import type { EmbedDocumentsFn } from '../../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../../src/lib/obsidian/corpus/vector-codec.js';
import { createVaultScope, type VaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import {
  createReconcileLoop,
  type IReconcileLoop,
  type IReconcileLoopDeps,
} from '../../../src/lib/vault-entry/reconcile-loop.js';
import {
  createVaultEntry,
  type IVaultEntry,
  type IVaultEntryOptions,
} from '../../../src/lib/vault-entry/vault-entry.js';
import type { WatcherFactory } from '../../../src/lib/vault-entry/watcher.js';
import { identityOf, MODEL_PROFILES } from '../../../src/lib/model-profiles.js';

const HARRIER = 'harrier-270m';
const IDENTITY = corpusIdentityOf(identityOf(MODEL_PROFILES[HARRIER]));
const DIMS = IDENTITY.dims;

/** A unit vector along `axis`, leaning a little towards axis 0 so every pair has a positive cosine. */
const axisVec = (axis: number) => {
  const v = new Array<number>(DIMS).fill(0);
  v[0] = 0.1;
  v[axis] = 1;
  return v;
};
const okEmbed: EmbedDocumentsFn = async (texts) => texts.map(() => axisVec(1));
const scopeOf = (exclusions: string[] = []) => createVaultScope({ configExclusions: exclusions });

/** A lock that never lets a pass in: the pass waits until the loop aborts it on dispose. */
const heldLock = (async (_root: string, opts: ILockedPassOptions) => {
  await new Promise((resolve) => opts.signal?.addEventListener('abort', resolve));
  return undefined;
}) as typeof withReconcileLock;

function fakeWatchers() {
  const started: Array<{ scope: unknown; close: ReturnType<typeof vi.fn> }> = [];
  const factory: WatcherFactory = ({ scope }) => {
    const close = vi.fn(async () => {});
    started.push({ scope, close });
    return { close };
  };
  return { started, factory };
}

const roots: string[] = [];
const entries: IVaultEntry[] = [];

afterEach(async () => {
  await Promise.all(entries.splice(0).map((entry) => entry.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  opts: {
    scope?: VaultScope;
    semantic?: boolean;
    embed?: EmbedDocumentsFn;
    loop?: Partial<IReconcileLoopDeps>;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-vault-entry-'));
  roots.push(root);
  const watchers = fakeWatchers();
  const loops: IReconcileLoop[] = [];
  const warn = vi.fn();
  const options: IVaultEntryOptions = {
    vaultRoot: root,
    vaultName: 'v',
    scope: opts.scope ?? scopeOf(),
    semantic: opts.semantic ?? true,
    embedderFor: () => opts.embed ?? okEmbed,
    warn,
    createWatcher: watchers.factory,
    createLoop: (deps) => {
      const loop = createReconcileLoop({ ...deps, ...opts.loop });
      vi.spyOn(loop, 'requestPass');
      vi.spyOn(loop, 'addProfile');
      loops.push(loop);
      return loop;
    },
  };
  const entry = createVaultEntry(options);
  entries.push(entry);
  return { root, entry, watchers, warn, loop: () => loops[0] };
}

/** A compatible corpus for HARRIER holding these notes, each with one block on the same vector. */
async function seed(root: string, notes: Record<string, number>) {
  const store = new ShardStore(root, { modelKey: HARRIER, dims: DIMS });
  await store.writeManifest({ ...IDENTITY, created: 'seeded' });
  for (const [notePath, axis] of Object.entries(notes)) {
    await store.writeShard({
      path: notePath,
      content_hash: contentHash(notePath),
      mtime: 1,
      size: 1,
      embedding: encodeVector(axisVec(axis)),
      blocks: [
        {
          key: `${notePath}#h`,
          heading: 'h',
          lines: [1, 2],
          embedding: encodeVector(axisVec(axis)),
        },
      ],
    });
  }
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe('createVaultEntry', () => {
  it('reads fold the scope', async () => {
    const h = await harness({ scope: scopeOf(['Archive/**']), loop: { withLock: heldLock } });
    // Archive/x.md is the closer one, so a limit applied before the exclusion would pick it.
    await seed(h.root, { 'Archive/x.md': 2, 'Notes/y.md': 3 });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));

    const reader = h.entry.reader(HARRIER);
    const anchor = { vector: axisVec(2) };
    const paths = (hits: ({ path: string }[] | null)[]) => (hits[0] ?? []).map((hit) => hit.path);

    expect(paths(await reader.nearest([anchor], { threshold: -1 }))).toEqual(['Notes/y.md']);
    expect(paths(await reader.nearest([anchor], { threshold: -1, limit: 1 }))).toEqual([
      'Notes/y.md',
    ]);
    const allowed = ['Archive/x.md', 'Notes/y.md'];
    expect(paths(await reader.nearest([anchor], { threshold: -1, allowed }))).toEqual([
      'Notes/y.md',
    ]);
    expect(
      paths(await reader.nearest([anchor], { threshold: -1, allowed, exclude: ['Notes/y.md'] })),
    ).toEqual([]);
    expect(paths(await reader.nearestBlocks([anchor], { paths: allowed, threshold: -1 }))).toEqual([
      'Notes/y.md',
    ]);
  });

  it('a path anchor on an excluded note not yet swept reads as null', async () => {
    const h = await harness({ scope: scopeOf(['Archive/**']), loop: { withLock: heldLock } });
    await seed(h.root, { 'Archive/x.md': 2, 'Notes/y.md': 3 });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));

    const reader = h.entry.reader(HARRIER);
    const anchors = [{ path: 'Archive/x.md' }, { path: 'Notes/y.md' }, { path: 'Archive/x.md' }];
    const notes = await reader.nearest(anchors, { threshold: -1 });
    expect(notes[0]).toBeNull();
    expect(notes[2]).toBeNull();
    expect((notes[1] ?? []).map((hit) => hit.path)).toEqual(['Notes/y.md']);
    const blocks = await reader.nearestBlocks(anchors, {
      paths: ['Archive/x.md', 'Notes/y.md'],
      threshold: -1,
    });
    expect(blocks[0]).toBeNull();
    expect(blocks[2]).toBeNull();
    expect((blocks[1] ?? []).map((hit) => hit.path)).toEqual(['Notes/y.md']);
  });

  it.each(['nearest', 'nearestBlocks'] as const)(
    'a scope change while %s is reading keeps answers aligned with their anchors',
    async (method) => {
      const h = await harness({ scope: scopeOf(['Archive/**']), loop: { withLock: heldLock } });
      await seed(h.root, { 'Archive/x.md': 2, 'Notes/y.md': 3, 'Notes/z.md': 4 });
      h.entry.addProfile(HARRIER);
      await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));
      // The scope lifts the exclusion at the moment the corpus starts the read.
      type Read = (this: ShardCorpus, ...args: unknown[]) => Promise<unknown>;
      const original = ShardCorpus.prototype[method] as unknown as Read;
      const spy = vi.spyOn(ShardCorpus.prototype, method).mockImplementation(function (
        this: ShardCorpus,
        ...args: unknown[]
      ) {
        const pending = original.apply(this, args);
        h.entry.setScope(scopeOf());
        return pending;
      } as never);

      try {
        const reader = h.entry.reader(HARRIER);
        const anchors = [{ path: 'Archive/x.md' }, { path: 'Notes/y.md' }, { path: 'Notes/z.md' }];
        const all = ['Archive/x.md', 'Notes/y.md', 'Notes/z.md'];
        const answers =
          method === 'nearest'
            ? await reader.nearest(anchors, { threshold: -1 })
            : await reader.nearestBlocks(anchors, { paths: all, threshold: -1 });

        // Decided by the scope the read started under: x was excluded, y and z were not.
        expect(answers[0]).toBeNull();
        expect(answers[1]?.[0]?.path).toBe('Notes/y.md');
        expect(answers[2]?.[0]?.path).toBe('Notes/z.md');
      } finally {
        spy.mockRestore();
      }
    },
  );

  it('setScope restarts the watcher, queues one pass and applies to reads at once', async () => {
    const h = await harness({ loop: { withLock: heldLock } });
    await seed(h.root, { 'Archive/x.md': 2, 'Notes/y.md': 3 });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));
    const anchor = { vector: axisVec(2) };
    const reader = h.entry.reader(HARRIER);
    expect((await reader.nearest([anchor], { threshold: -1 }))[0]).toHaveLength(2);
    expect(h.watchers.started).toHaveLength(1);
    const requests = vi.mocked(h.loop().requestPass).mock.calls.length;

    const next = scopeOf(['Archive/**']);
    h.entry.setScope(next);

    expect(h.entry.scope).toBe(next);
    expect(h.watchers.started).toHaveLength(2);
    expect(h.watchers.started[0].close).toHaveBeenCalledTimes(1);
    expect(h.watchers.started[1].scope).toBe(next);
    expect(vi.mocked(h.loop().requestPass).mock.calls.length - requests).toBe(1);
    const hits = (await reader.nearest([anchor], { threshold: -1 }))[0] ?? [];
    expect(hits.map((hit) => hit.path)).toEqual(['Notes/y.md']);
  });

  it('a profile on a cold vault reports indexing 0/0 at once', async () => {
    const h = await harness({ loop: { withLock: heldLock } });
    h.entry.addProfile(HARRIER);
    expect(h.entry.status(HARRIER)).toEqual({ state: 'indexing', indexed: 0, total: 0 });
  });

  it('a disabled vault touches nothing under .neuro-vault/corpus/', async () => {
    const h = await harness({ semantic: false });
    h.entry.addProfile(HARRIER);
    expect(h.entry.status(HARRIER)).toEqual({ state: 'disabled' });
    expect(h.loop().addProfile).not.toHaveBeenCalled();
    await h.loop().whenSettled();
    expect(await exists(path.join(h.root, '.neuro-vault'))).toBe(false);
    expect(h.entry.info(1).profiles).toEqual([{ profile: HARRIER, state: 'disabled' }]);
  });

  it('setSemantic disables the profiles and re-enables them on a fresh corpus', async () => {
    const h = await harness({ loop: { withLock: heldLock } });
    await seed(h.root, { 'Notes/y.md': 3 });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));
    const before = vi.mocked(h.loop().addProfile).mock.calls[0][0].corpus;

    h.entry.setSemantic(false);
    expect(h.entry.semantic).toBe(false);
    expect(h.entry.status(HARRIER)).toEqual({ state: 'disabled' });
    expect(before.loaded).toBe(false);
    expect(() => h.loop().status(HARRIER)).toThrow(/unknown profile/);

    h.entry.setSemantic(true);
    const calls = vi.mocked(h.loop().addProfile).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0].corpus).not.toBe(before);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));
  });

  it('setSemantic(false) mid-reconcile stops embedding after the note in flight', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let embeds = 0;
    const h = await harness({
      embed: async (texts) => {
        embeds += 1;
        await held;
        return okEmbed(texts);
      },
    });
    await mkdir(path.join(h.root, 'Notes'));
    for (const name of ['a', 'b', 'c']) {
      await writeFile(path.join(h.root, 'Notes', `${name}.md`), `# ${name}\n${'x'.repeat(400)}\n`);
    }
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(embeds).toBe(1));
    h.entry.setSemantic(false);
    release();
    await h.loop().whenSettled();
    expect(embeds).toBe(1);
    expect(h.entry.status(HARRIER)).toEqual({ state: 'disabled' });
  });

  it('info reports notes and the last reconcile once a pass made the profile ready', async () => {
    const h = await harness();
    await mkdir(path.join(h.root, 'Notes'));
    await writeFile(path.join(h.root, 'Notes', 'y.md'), `# y\n${'x'.repeat(400)}\n`);
    h.entry.addProfile(HARRIER);
    await h.loop().whenSettled();
    const [info] = h.entry.info(2).profiles;
    expect(info).toMatchObject({ profile: HARRIER, state: 'ready', notes: 1 });
    expect(info.last_reconcile).toMatchObject({ added: 1, changed: 0, removed: 0 });
    expect(h.entry.info(2)).toMatchObject({ vault: h.root, clients: 2 });
    expect(h.entry.info(0, '2026-01-01T00:00:00.000Z').idle_since).toBe('2026-01-01T00:00:00.000Z');
  });

  it('info carries the reason of an unavailable profile', async () => {
    const failingLock = (async () => {
      throw new Error('lock down');
    }) as unknown as typeof withReconcileLock;
    const h = await harness({ loop: { withLock: failingLock } });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER).state).toBe('unavailable'));
    expect(h.entry.info(1).profiles).toEqual([
      expect.objectContaining({
        profile: HARRIER,
        state: 'unavailable',
        reason: expect.stringContaining('lock down'),
      }),
    ]);
  });

  it('removeProfile leaves the loop and frees the vectors', async () => {
    const h = await harness({ loop: { withLock: heldLock } });
    await seed(h.root, { 'Notes/y.md': 3 });
    h.entry.addProfile(HARRIER);
    await vi.waitFor(() => expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' }));
    const corpus = vi.mocked(h.loop().addProfile).mock.calls[0][0].corpus;
    h.entry.removeProfile(HARRIER);
    expect(corpus.loaded).toBe(false);
    expect(h.entry.info(0).profiles).toEqual([]);
  });

  it('restarts the watcher when a pass finds the vault directory back', async () => {
    const h = await harness();
    h.entry.addProfile(HARRIER);
    await h.loop().whenSettled();
    await rm(h.root, { recursive: true, force: true });
    h.loop().requestPass();
    await h.loop().whenSettled();
    expect(h.entry.status(HARRIER).state).toBe('unavailable');
    expect(h.watchers.started).toHaveLength(1);

    // A new directory is a new inode: the old watch saw it go and sees nothing of it.
    await mkdir(h.root);
    h.loop().requestPass();
    await h.loop().whenSettled();
    expect(h.entry.status(HARRIER)).toEqual({ state: 'ready' });
    expect(h.watchers.started).toHaveLength(2);
    expect(h.watchers.started[0].close).toHaveBeenCalledTimes(1);
    expect(h.watchers.started[1].scope).toBe(h.entry.scope);
  });

  it('a watcher that fails to start is logged and the entry keeps serving', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-vault-entry-'));
    roots.push(root);
    const warn = vi.fn();
    const entry = createVaultEntry({
      vaultRoot: root,
      vaultName: 'v',
      scope: scopeOf(),
      semantic: true,
      embedderFor: () => okEmbed,
      warn,
      createWatcher: () => {
        throw new Error('EMFILE');
      },
      createLoop: (deps) => createReconcileLoop({ ...deps, withLock: heldLock }),
    });
    entries.push(entry);
    entry.addProfile(HARRIER);
    expect(entry.status(HARRIER)).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/failed to start.*EMFILE/));
    entry.setScope(scopeOf(['Archive/**']));
    expect(entry.scope.ignorePatterns).toContain('Archive/**');
  });

  it('debounceMs sets how long a watched change waits before it queues a pass', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-vault-entry-'));
    roots.push(root);
    let changed: () => void = () => {};
    const passes: IReconcileLoop[] = [];
    const entry = createVaultEntry({
      vaultRoot: root,
      vaultName: 'v',
      scope: scopeOf(),
      semantic: true,
      debounceMs: 40,
      embedderFor: () => okEmbed,
      warn: vi.fn(),
      createWatcher: ({ onChange }) => {
        changed = onChange;
        return { close: async () => {} };
      },
      createLoop: (deps) => {
        const loop = createReconcileLoop({ ...deps, withLock: heldLock });
        vi.spyOn(loop, 'requestPass');
        passes.push(loop);
        return loop;
      },
    });
    entries.push(entry);

    changed();
    changed();
    expect(passes[0].requestPass).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(passes[0].requestPass).toHaveBeenCalledTimes(1), {
      timeout: 1_000,
    });
  });

  it('dispose closes the watcher and is idempotent', async () => {
    const h = await harness({ loop: { withLock: heldLock } });
    h.entry.addProfile(HARRIER);
    await Promise.all([h.entry.dispose(), h.entry.dispose()]);
    await h.entry.dispose();
    expect(h.watchers.started[0].close).toHaveBeenCalledTimes(1);
  });

  it('dispose aborts the pass in flight without waiting for the watcher to close', async () => {
    let entered!: () => void;
    const inLock = new Promise<void>((resolve) => (entered = resolve));
    let aborted = false;
    const recordingLock = (async (_root: string, opts: ILockedPassOptions) => {
      entered();
      await new Promise<void>((resolve) =>
        opts.signal?.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }),
      );
      return undefined;
    }) as typeof withReconcileLock;
    const h = await harness({ loop: { withLock: recordingLock } });
    h.entry.addProfile(HARRIER);
    h.entry.requestPass();
    await inLock;
    let closed!: () => void;
    h.watchers.started[0].close.mockImplementation(
      () => new Promise<void>((resolve) => (closed = resolve)),
    );
    const disposed = h.entry.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(aborted).toBe(true);
    closed();
    await disposed;
  });
});
