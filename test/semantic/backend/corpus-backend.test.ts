import { describe, expect, it, vi } from 'vitest';

import { createCorpusBackend } from '../../../src/modules/semantic/backend/corpus-backend.js';
import { buildBasenameIndex } from '../../../src/lib/obsidian/link-resolver.js';
import type { CorpusSnapshot } from '../../../src/lib/obsidian/semantic-backend.js';
import type { CorpusStore } from '../../../src/lib/obsidian/corpus/shard-store.js';
import type { ReconcileSummary } from '../../../src/lib/obsidian/corpus/reconcile.js';

const EMPTY: CorpusSnapshot = { sources: new Map(), basenameIndex: buildBasenameIndex([]) };

function snapshotWith(paths: string[]): CorpusSnapshot {
  return {
    sources: new Map(paths.map((p) => [p, { path: p, embedding: [1], blocks: [] }])),
    basenameIndex: buildBasenameIndex(paths),
  };
}

function summary(over: Partial<ReconcileSummary> = {}): ReconcileSummary {
  return { total: 1, embedded: 0, reused: 1, renamed: 0, deleted: 0, failed: 0, ...over };
}

/** A store whose manifest and shard count are set per test. */
function fakeStore(opts: { compatible: boolean; shards: number }): CorpusStore {
  return {
    readManifest: async () =>
      opts.compatible
        ? {
            embed_version: 1,
            model_key: 'bge-micro-v2',
            model_id: 'TaylorAI/bge-micro-v2',
            dims: 384,
            strategy: 'sc-parity-v1',
            created: 'now',
          }
        : {
            embed_version: 99,
            model_key: 'other',
            model_id: 'other',
            dims: 1,
            strategy: 'x',
            created: 'now',
          },
    listShards: async () =>
      new Map(Array.from({ length: opts.shards }, (_, i) => [`n${i}.md`, {}])) as never,
  } as unknown as CorpusStore;
}

describe('createCorpusBackend', () => {
  it('reports disabled and does no work when the vault opted out', async () => {
    const reconcile = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: false,
      store: fakeStore({ compatible: true, shards: 3 }),
      loadSnapshot: async () => EMPTY,
      reconcile,
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await backend.snapshot()).sources.size).toBe(0);
  });

  it('stays disabled when a reconcile is requested for an opted-out vault', async () => {
    const reconcile = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: false,
      store: fakeStore({ compatible: true, shards: 3 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile,
    });
    backend.requestReconcile();
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(reconcile).not.toHaveBeenCalled();
    expect((await backend.snapshot()).sources.size).toBe(0);
  });

  it('serves a compatible corpus immediately and reconciles behind it', async () => {
    const reconcile = vi.fn(async () => summary());
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 2 }),
      loadSnapshot: async () => snapshotWith(['a.md', 'b.md']),
      reconcile,
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(2);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('reports indexing with progress before the first index lands', async () => {
    let emit: ((p: { indexed: number; total: number }) => void) | undefined;
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async ({ onProgress }) => {
        emit = onProgress;
        emit?.({ indexed: 0, total: 840 });
        emit?.({ indexed: 120, total: 840 });
        return summary({ total: 840, embedded: 840 });
      },
    });
    expect(backend.status()).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
  });

  it('promotes the finished index without a restart', async () => {
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async () => summary({ embedded: 1 }),
    });
    expect((await backend.snapshot()).sources.size).toBe(0);
    await backend.whenSettled();
    expect((await backend.snapshot()).sources.size).toBe(1);
  });

  it('does not rebuild the snapshot when nothing changed', async () => {
    const loadSnapshot = vi.fn(async () => snapshotWith(['a.md']));
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot,
      reconcile: async () => summary(),
    });
    await backend.whenSettled();
    expect(loadSnapshot).toHaveBeenCalledTimes(1); // startup load only
  });

  it('never reports ready over a snapshot the startup read failed to load', async () => {
    const warn = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: {
        readManifest: () => Promise.reject(new Error('EIO')),
        listShards: () => Promise.reject(new Error('EIO')),
      } as unknown as CorpusStore,
      loadSnapshot: async () => snapshotWith(['a.md']),
      // The repairing pass is exactly the one that finds nothing to do.
      reconcile: async () => summary(),
      warn,
    });
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(1);
  });

  it('does not let the startup selection clobber a snapshot a pass already loaded', async () => {
    // Both no-ops until the corresponding step is reached — declared callable so
    // control flow analysis cannot narrow them to `never` at the call sites.
    let startupLoadReached: () => void = () => {};
    let releaseStartupLoad: () => void = () => {};
    const startupLoadBegun = new Promise<void>((resolve) => {
      startupLoadReached = resolve;
    });
    const startupLoadGate = new Promise<void>((resolve) => {
      releaseStartupLoad = resolve;
    });

    let loads = 0;
    const loadSnapshot = async (): Promise<CorpusSnapshot> => {
      loads += 1;
      if (loads === 1) {
        // The startup selection, decoded from the corpus as it was before the
        // pass ran and held in flight until the pass has moved on.
        startupLoadReached();
        await startupLoadGate;
        return snapshotWith(['stale.md']);
      }
      return snapshotWith(['fresh.md']);
    };

    let attempt = 0;
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot,
      // Only the first pass moves the corpus; the follow-up finds nothing to do
      // and so declines to reload — which is what makes a clobber permanent.
      reconcile: async () => {
        attempt += 1;
        return attempt === 1 ? summary({ embedded: 1 }) : summary();
      },
    });

    await startupLoadBegun;
    backend.requestReconcile(); // a watcher tick beating the startup selection
    await backend.whenSettled();
    expect([...(await backend.snapshot()).sources.keys()]).toEqual(['fresh.md']);

    releaseStartupLoad();
    await backend.whenSettled();
    expect([...(await backend.snapshot()).sources.keys()]).toEqual(['fresh.md']);
  });

  it('reports unavailable with a reason when a pass throws', async () => {
    const warn = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => EMPTY,
      reconcile: async () => {
        throw new Error('EACCES');
      },
      warn,
    });
    await backend.whenSettled();
    expect(backend.status()).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('EACCES'),
    });
    expect(warn).toHaveBeenCalled();
  });

  it('recovers from a failed pass without a restart', async () => {
    let attempt = 0;
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('EACCES');
        return summary({ embedded: 1 });
      },
      warn: vi.fn(),
    });
    await backend.whenSettled();
    expect(backend.status().state).toBe('unavailable');
    backend.requestReconcile();
    await backend.whenSettled();
    expect(backend.status()).toEqual({ state: 'ready' });
    expect((await backend.snapshot()).sources.size).toBe(1);
  });

  it('coalesces reconcile requests arriving during a pass', async () => {
    // A no-op until a pass is actually in flight — declared callable so control
    // flow analysis cannot narrow it to `never` at the call site below.
    let finishRunningPass: () => void = () => {};
    const reconcile = vi.fn(
      () =>
        new Promise<ReconcileSummary>((resolve) => {
          finishRunningPass = () => resolve(summary());
        }),
    );
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot: async () => EMPTY,
      reconcile,
    });
    backend.requestReconcile();
    backend.requestReconcile();
    finishRunningPass(); // resolve the pass the first request started
    await backend.whenSettled();
    expect(reconcile.mock.calls.length).toBe(2); // the first request's pass + one coalesced follow-up
  });

  it('stops scheduling passes after dispose', async () => {
    const reconcile = vi.fn(async () => summary());
    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: true, shards: 1 }),
      loadSnapshot: async () => EMPTY,
      reconcile,
    });
    await backend.whenSettled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    await backend.dispose();
    backend.requestReconcile();
    await backend.whenSettled();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
