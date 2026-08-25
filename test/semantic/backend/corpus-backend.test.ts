import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCorpusBackend } from '../../../src/modules/semantic/backend/corpus-backend.js';
import { buildBasenameIndex } from '../../../src/lib/obsidian/link-resolver.js';
import type { CorpusSnapshot } from '../../../src/lib/obsidian/semantic-backend.js';
import { CorpusStore } from '../../../src/lib/obsidian/corpus/shard-store.js';
import {
  reconcileCorpus,
  type ReconcileSummary,
} from '../../../src/lib/obsidian/corpus/reconcile.js';
import { loadCorpusSnapshot } from '../../../src/lib/obsidian/corpus/snapshot.js';
import { MODEL_DIMS, type EmbedFn } from '../../../src/lib/obsidian/corpus/types.js';

const EMPTY: CorpusSnapshot = { sources: new Map(), basenameIndex: buildBasenameIndex([]) };

type CorpusBackendHandle = ReturnType<typeof createCorpusBackend>;
type Progress = (p: { indexed: number; total: number }) => void;

/**
 * Timer seam for the self-retry, so a backoff test asserts on the delay asked
 * for and fires it by hand — no real waiting, and nothing to make flaky.
 */
function fakeTimers(collected: Array<{ fn: () => void; ms: number }>) {
  return {
    setTimer: ((fn: () => void, ms: number) =>
      collected.push({ fn, ms })) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as unknown as typeof clearTimeout,
  };
}

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

/**
 * `reconcileCorpus` is deliberately per-note tolerant: a rejected `embed` is
 * counted in `summary.failed`, warned about, and the pass returns normally.
 * "The pass did not throw" is therefore not the same as "the index is good",
 * so these tests drive the real reconcile against a real store and the real
 * snapshot loader rather than asserting through a hand-set status.
 */
describe('createCorpusBackend over a real reconcile', () => {
  const body = (marker: string) => `# ${marker}\n${'x'.repeat(400)}\n`;

  /** A cold vault on disk, wired to the production reconcile/store/loader. */
  async function coldVault(files: Record<string, string>) {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-backend-'));
    const store = new CorpusStore(root);
    // Swapped per pass, so a vault that recovers can be exercised too.
    let embed: EmbedFn = () => {
      throw new Error('ONNX model failed to load');
    };
    // Two separate mocks on purpose: reconcile's per-note warnings would
    // otherwise satisfy an assertion meant for the backend's own.
    const reconcileWarn = vi.fn();
    const backendWarn = vi.fn();
    const backend = createCorpusBackend({
      vaultRoot: root,
      vaultName: 'v',
      enabled: true,
      store,
      loadSnapshot: loadCorpusSnapshot,
      reconcile: (opts) =>
        reconcileCorpus(
          {
            vaultRoot: root,
            scan: async () => Object.keys(files).sort(),
            stat: async (p) => ({ mtime: 1, size: files[p].length }),
            readNote: async (p) => ({ content: files[p], mtime: 1, size: files[p].length }),
            embed: (text) => embed(text),
            store,
            warn: reconcileWarn,
          },
          opts,
        ),
      warn: backendWarn,
    });
    return {
      backend,
      backendWarn,
      reconcileWarn,
      repairEmbed: () => {
        embed = async () => new Array<number>(MODEL_DIMS).fill(0.1);
      },
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it('reports unavailable when every note of a cold vault fails to embed', async () => {
    const { backend, backendWarn, cleanup } = await coldVault({
      'a.md': body('a'),
      'b.md': body('b'),
    });
    try {
      await backend.whenSettled();
      // Not `ready`: the pass wrote no shard, so there is nothing to serve —
      // and not `disabled`, which is reserved for a deliberate opt-out.
      expect(backend.status().state).toBe('unavailable');
      expect(backend.status().reason).toBeTruthy();
      expect((await backend.snapshot()).sources.size).toBe(0);
      // The backend's own warning, on its own mock — reconcile's per-note
      // warnings go to `reconcileWarn` and cannot satisfy this.
      expect(backendWarn).toHaveBeenCalledWith(
        expect.stringContaining('corpus unavailable for vault "v"'),
      );
    } finally {
      await cleanup();
    }
  });

  it('stays unavailable when the only note that indexed is below the size gate', async () => {
    // `stub.md` is under MIN_CHARS: `buildEmbedInputs` gives it no note vector
    // and no qualifying block, so `embedNote` calls `embed` zero times, writes
    // a shard with `embedding: null`, and still counts as `embedded` — while
    // contributing no source to the decoded snapshot. A guard that required
    // `embedded === 0` would stay silent on this routine vault shape.
    const { backend, cleanup } = await coldVault({
      'stub.md': '# stub\n',
      'a.md': body('a'),
      'b.md': body('b'),
    });
    try {
      await backend.whenSettled();
      expect(backend.status().state).toBe('unavailable');
      expect((await backend.snapshot()).sources.size).toBe(0);

      // Durability is half the defect: the next pass reuses the stub and
      // reports no change at all, so a latched `snapshotLoaded` would skip the
      // load branch and report `ready` over the empty corpus until something
      // in the vault happened to change.
      backend.requestReconcile();
      await backend.whenSettled();
      expect(backend.status().state).toBe('unavailable');
      expect((await backend.snapshot()).sources.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('promotes to ready once a later pass can embed again', async () => {
    const { backend, repairEmbed, cleanup } = await coldVault({
      'a.md': body('a'),
      'b.md': body('b'),
    });
    try {
      await backend.whenSettled();
      expect(backend.status().state).toBe('unavailable');

      repairEmbed();
      backend.requestReconcile();
      await backend.whenSettled();

      expect(backend.status()).toEqual({ state: 'ready' });
      expect([...(await backend.snapshot()).sources.keys()].sort()).toEqual(['a.md', 'b.md']);
    } finally {
      await cleanup();
    }
  });

  it('reports ready for an empty vault, which has nothing to fail at', async () => {
    const { backend, cleanup } = await coldVault({});
    try {
      await backend.whenSettled();
      expect(backend.status()).toEqual({ state: 'ready' });
      expect((await backend.snapshot()).sources.size).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it('reports ready when only some notes fail and the rest are served', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-backend-partial-'));
    try {
      const store = new CorpusStore(root);
      const files: Record<string, string> = { 'good.md': body('good'), 'bad.md': body('bad') };
      const backend = createCorpusBackend({
        vaultRoot: root,
        vaultName: 'v',
        enabled: true,
        store,
        loadSnapshot: loadCorpusSnapshot,
        reconcile: (opts) =>
          reconcileCorpus(
            {
              vaultRoot: root,
              scan: async () => Object.keys(files).sort(),
              stat: async (p) => ({ mtime: 1, size: files[p].length }),
              readNote: async (p) => {
                if (p === 'bad.md') throw new Error('EACCES');
                return { content: files[p], mtime: 1, size: files[p].length };
              },
              embed: async () => new Array<number>(MODEL_DIMS).fill(0.1),
              store,
              warn: vi.fn(),
            },
            opts,
          ),
        warn: vi.fn(),
      });
      await backend.whenSettled();
      expect(backend.status()).toEqual({ state: 'ready' });
      expect([...(await backend.snapshot()).sources.keys()]).toEqual(['good.md']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('re-enters indexing, with counters, while rebuilding after a failure', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const during: Array<ReturnType<CorpusBackendHandle['status']>> = [];
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async (opts: { onProgress?: Progress }) => {
        during.push(backend.status());
        opts.onProgress?.({ indexed: 2, total: 5 });
        during.push(backend.status());
        return summary({ embedded: 1 });
      });

    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile,
      warn: vi.fn(),
      retryBaseMs: 1_000,
      ...fakeTimers(timers),
    });

    await backend.whenSettled();
    expect(backend.status().state).toBe('unavailable');

    timers[0].fn();
    await backend.whenSettled();

    // A rebuild in flight is a build in flight — reporting `unavailable` across
    // it would tell the caller to start a second, competing indexer.
    expect(during[0]).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(during[1]).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(backend.status()).toEqual({ state: 'ready' });
  });

  it('retries a failed pass on its own, with no vault change to trigger it', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('no model on disk'))
      .mockResolvedValueOnce(summary({ embedded: 1 }));

    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      reconcile,
      warn: vi.fn(),
      retryBaseMs: 1_000,
      ...fakeTimers(timers),
    });

    await backend.whenSettled();
    // The watcher is the only other caller of `kick()`, so without this timer a
    // vault nobody edits would stay broken until the process restarts.
    expect(timers.map((t) => t.ms)).toEqual([1_000]);

    timers[0].fn();
    await backend.whenSettled();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(backend.status()).toEqual({ state: 'ready' });
    // A recovered vault starts its backoff over rather than staying at 2s.
    expect(timers).toHaveLength(1);
  });

  it('aborts the reconcile in flight when disposed', async () => {
    let started: () => void = () => {};
    const passStarted = new Promise<void>((resolve) => (started = resolve));
    let seen: AbortSignal | undefined;

    const backend = createCorpusBackend({
      vaultRoot: '/v',
      vaultName: 'v',
      enabled: true,
      store: fakeStore({ compatible: false, shards: 0 }),
      loadSnapshot: async () => snapshotWith(['a.md']),
      // Settles only on abort: a cold index is thousands of reads and embeds,
      // and nothing else would stop them once the client hung up.
      reconcile: (opts) =>
        new Promise((resolve) => {
          seen = opts.signal;
          started();
          opts.signal?.addEventListener('abort', () => resolve(summary()));
        }),
      warn: vi.fn(),
    });

    await passStarted;
    await backend.dispose();
    await backend.whenSettled();

    expect(seen?.aborted).toBe(true);
    // A disposed pass promotes nothing — its summary is partial by construction.
    expect(backend.status().state).not.toBe('ready');
  });
});
