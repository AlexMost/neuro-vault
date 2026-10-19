import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ICorpus } from '../../../src/lib/obsidian/corpus/corpus.js';
import {
  corpusIdentityOf,
  type CorpusIdentity,
} from '../../../src/lib/obsidian/corpus/identity.js';
import {
  contentHash,
  type ILockedPassOptions,
  type NoteContent,
  type withReconcileLock,
} from '../../../src/lib/obsidian/corpus/reconcile.js';
import { modelCorpusDir } from '../../../src/lib/obsidian/corpus/layout.js';
import { CorpusLockTimeoutError } from '../../../src/lib/obsidian/corpus/reconcile-lock.js';
import { ShardCorpus } from '../../../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../../../src/lib/obsidian/corpus/shard-store.js';
import type { EmbedDocumentsFn } from '../../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../../src/lib/obsidian/corpus/vector-codec.js';
import {
  createReconcileLoop,
  type ILoopProfile,
  type IReconcileLoop,
  type IReconcileLoopDeps,
} from '../../../src/lib/vault-entry/reconcile-loop.js';
import { TEST_DIMS, TEST_EMBEDDING_IDENTITY, TEST_IDENTITY } from '../../_identity.js';
import { MemoryCorpus, memoryStore, type IMemoryStore } from '../../_memory-corpus.js';

const SECOND_IDENTITY: CorpusIdentity = corpusIdentityOf({
  ...TEST_EMBEDDING_IDENTITY,
  model_key: 'second-model',
  model_id: 'test/second-model',
});

const body = (marker: string) => `# ${marker}\n${'x'.repeat(400)}\n`;
const vec = (fill: number) => new Array<number>(TEST_DIMS).fill(fill);
const okEmbed: EmbedDocumentsFn = async (texts) => texts.map(() => vec(0.1));
const LOCK_FILE = '/v/.neuro-vault/corpus/reconcile.lock';
const lockTimeout = () => new CorpusLockTimeoutError(LOCK_FILE, 4242, 1_800_000);

type Timers = Array<{ fn: () => void; ms: number }>;

/**
 * Timer seam for the self-retry, so a backoff test asserts on the delay asked
 * for and fires it by hand — no real waiting, and nothing to make flaky.
 */
function fakeTimers(collected: Timers) {
  return {
    setTimer: ((fn: () => void, ms: number) =>
      collected.push({ fn, ms })) as unknown as typeof setTimeout,
    clearTimer: (() => {}) as unknown as typeof clearTimeout,
  };
}

/** A promise opened by hand. */
function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

interface LockCall {
  /** Resolve to let the call proceed; runs before `throws` / `waited`. */
  gate?: Promise<void>;
  throws?: Error;
  waited?: boolean;
  /** Stands in for another holder's work, done before this pass gets the lock. */
  before?: () => Promise<void>;
}

/** The lock seam: per-call behaviour, a call counter, and whoever is waiting on it. */
function scriptedLock(script: (call: number) => LockCall = () => ({})) {
  let calls = 0;
  const reached: Array<() => void> = [];
  const withLock = (async (
    _root: string,
    opts: ILockedPassOptions,
    fn: (ctx: { waited: boolean }) => Promise<unknown>,
  ) => {
    calls += 1;
    const step = script(calls);
    for (const notify of reached.splice(0)) notify();
    // Abort releases a gate too, so a failed assertion cannot wedge the afterEach dispose.
    if (step.gate) {
      await Promise.race([
        step.gate,
        new Promise((resolve) => opts.signal?.addEventListener('abort', resolve)),
      ]);
    }
    if (step.throws) throw step.throws;
    if (opts.signal?.aborted) return undefined;
    await step.before?.();
    return fn({ waited: step.waited ?? false });
  }) as typeof withReconcileLock;
  return {
    withLock,
    calls: () => calls,
    /** Resolves when the next lock call is made. */
    nextCall: () => new Promise<void>((resolve) => reached.push(resolve)),
  };
}

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
    remove: (p: string) => state.delete(p),
  };
}

const roots: string[] = [];
const loops: IReconcileLoop[] = [];

afterEach(async () => {
  await Promise.all(loops.splice(0).map((loop) => loop.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A vault on disk with a loop over it; the lock defaults to a counting pass-through. */
async function harness(files: Record<string, string> = {}, over: Partial<IReconcileLoopDeps> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-loop-'));
  roots.push(root);
  const vault = fakeVault(files);
  const warn = vi.fn();
  const lock = scriptedLock();
  const scan = vi.fn(async () => vault.paths());
  const loop = createReconcileLoop({
    vaultRoot: root,
    vaultName: 'v',
    scan,
    stat: vault.stat,
    readNote: vault.readNote,
    warn,
    withLock: lock.withLock,
    ...over,
  });
  loops.push(loop);
  return { root, vault, warn, lock, scan, loop };
}

function corpusOn(root: string, identity: CorpusIdentity = TEST_IDENTITY) {
  const store = new ShardStore(root, { modelKey: identity.model_key, dims: TEST_DIMS });
  const corpus = new ShardCorpus(store, { yieldEvery: () => Promise.resolve() });
  return { store, corpus };
}

function profileOf(
  key: string,
  corpus: ICorpus,
  opts: { identity?: CorpusIdentity; embed?: EmbedDocumentsFn; enabled?: boolean } = {},
): ILoopProfile {
  return {
    key,
    identity: opts.identity ?? TEST_IDENTITY,
    corpus,
    embedDocuments: opts.embed ?? okEmbed,
    enabled: opts.enabled ?? true,
  };
}

/** Writes a compatible corpus whose records match `notes` as the fake vault reports them. */
async function seed(
  store: ShardStore,
  notes: Record<string, string>,
  opts: { identity?: CorpusIdentity; fill?: number; mtime?: number } = {},
): Promise<void> {
  await store.writeManifest({ ...(opts.identity ?? TEST_IDENTITY), created: 'seeded' });
  for (const [notePath, content] of Object.entries(notes)) {
    await store.writeShard({
      path: notePath,
      content_hash: contentHash(content),
      mtime: opts.mtime ?? 1,
      size: content.length,
      embedding: encodeVector(vec(opts.fill ?? 0.1)),
      blocks: [],
    });
  }
}

describe('createReconcileLoop, one profile', () => {
  it('reports disabled and does no work when the vault opted out', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, { 'a.md': body('a') });
    const embed = vi.fn(okEmbed);
    h.loop.addProfile(profileOf('p', corpus, { enabled: false, embed }));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'disabled' });
    expect(h.lock.calls()).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(corpus.loaded).toBe(false);
  });

  it('stays disabled when a pass is requested for an opted-out vault', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, { 'a.md': body('a') });
    h.loop.addProfile(profileOf('p', corpus, { enabled: false }));
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'disabled' });
    expect(h.lock.calls()).toBe(0);
    expect(h.scan).not.toHaveBeenCalled();
    expect(corpus.loaded).toBe(false);
  });

  it('serves a compatible corpus immediately and reconciles behind it', async () => {
    const files = { 'a.md': body('a'), 'b.md': body('b') };
    const statuses: unknown[] = [];
    const stat = fakeVault(files).stat;
    const h = await harness(files, {
      // Per note inside the pass, once the profile's selection has settled.
      stat: async (p) => {
        statuses.push(h.loop.status('p'));
        return stat(p);
      },
    });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(2);
    expect(h.lock.calls()).toBe(1);
    // A reconcile behind a corpus that is already serving must not take it off the air.
    expect(statuses).toEqual([{ state: 'ready' }, { state: 'ready' }]);
  });

  it('a vault directory that vanished is unavailable, not recreated, and recovers when back', async () => {
    const onVaultRestored = vi.fn();
    const h = await harness({ 'a.md': body('a') }, { onVaultRestored });
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    const passes = h.lock.calls();

    await rm(h.root, { recursive: true, force: true });
    h.loop.requestPass();
    await h.loop.whenSettled();

    const status = h.loop.status('p');
    expect(status).toMatchObject({ state: 'unavailable', reason: expect.stringContaining(h.root) });
    // The lock's `mkdir -p` would have recreated the directory; the scan would have swept the shards.
    expect(h.lock.calls()).toBe(passes);
    expect(h.scan).toHaveBeenCalledTimes(passes);
    await expect(access(h.root)).rejects.toThrow();
    expect(onVaultRestored).not.toHaveBeenCalled();

    await mkdir(h.root);
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    // Once per return of the directory, not per pass that finds it.
    expect(onVaultRestored).toHaveBeenCalledTimes(1);
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(onVaultRestored).toHaveBeenCalledTimes(1);
  });

  it('reports indexing with progress before the first index lands', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));
    expect(h.loop.status('p')).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it('promotes the finished index without a restart', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));
    expect(corpus.loaded).toBe(false);
    await h.loop.whenSettled();
    expect(corpus.size()).toBe(1);
    expect(corpus.vectorOf('a.md')).not.toBeNull();
  });

  it('does not reload the corpus when nothing changed', async () => {
    const files = { 'a.md': body('a') };
    const h = await harness(files);
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    const load = vi.spyOn(corpus, 'load');
    const refresh = vi.spyOn(corpus, 'refresh');
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(load).toHaveBeenCalledTimes(1); // startup load only
    expect(refresh).not.toHaveBeenCalled();
  });

  it('never reports ready over a corpus the startup read failed to load', async () => {
    const files = { 'a.md': body('a') };
    const statuses: unknown[] = [];
    const stat = fakeVault(files).stat;
    const h = await harness(files, {
      stat: async (p) => {
        statuses.push(h.loop.status('p'));
        return stat(p);
      },
    });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    // Fails once the pass is under way, so the pass finds the profile `unavailable`.
    vi.spyOn(corpus, 'identity').mockImplementationOnce(
      () => new Promise((_resolve, reject) => setImmediate(() => reject(new Error('EIO')))),
    );
    const embed = vi.fn(okEmbed);
    h.loop.addProfile(profileOf('p', corpus, { embed }));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(1);
    // The repairing pass is exactly the one that finds nothing to do.
    expect(embed).not.toHaveBeenCalled();
    // The selection failed while the pass was already under way; the pass that
    // repairs it is a build in flight, not an outage.
    expect(statuses).toEqual([{ state: 'indexing', indexed: 0, total: 0 }]);
  });

  it('does not let the startup selection clobber what a pass wrote', async () => {
    const h = await harness({ 'fresh.md': body('fresh') });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, { 'stale.md': body('stale') });
    // The startup selection's listing, read before the pass ran and held in
    // flight: swapped in after the pass's writes, it would erase them.
    const listed = gate();
    const release = gate();
    const realList = store.listShards.bind(store);
    vi.spyOn(store, 'listShards').mockImplementationOnce(async () => {
      const shards = await realList();
      listed.open();
      await release.promise;
      return shards;
    });
    const embedded = gate();
    const embed = vi.fn(async (texts: string[]) => {
      embedded.open();
      return okEmbed(texts);
    });
    h.loop.addProfile(profileOf('p', corpus, { embed }));
    await listed.promise;
    h.loop.requestPass(); // a watcher tick beating the startup selection
    // The pass must sit out the selection; given time, one that did not would embed.
    await Promise.race([embedded.promise, new Promise((resolve) => setTimeout(resolve, 300))]);
    expect(embed).not.toHaveBeenCalled();

    release.open();
    await h.loop.whenSettled();
    expect(corpus.vectorOf('fresh.md')).not.toBeNull();
    expect(corpus.vectorOf('stale.md')).toBeNull();
    expect(corpus.size()).toBe(1);
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it('leaves nothing resident when a profile is removed during its selection', async () => {
    const files = { 'a.md': body('a') };
    const h = await harness(files);
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    const listing = gate();
    const release = gate();
    const realList = store.listShards.bind(store);
    vi.spyOn(store, 'listShards').mockImplementationOnce(async () => {
      listing.open();
      await release.promise;
      return realList();
    });
    h.loop.addProfile(profileOf('p', corpus));
    await listing.promise;
    h.loop.removeProfile('p');
    corpus.dispose(); // the caller's half
    release.open();
    await h.loop.whenSettled();
    expect(corpus.loaded).toBe(false);
    expect(() => h.loop.status('p')).toThrow(/unknown profile "p"/);
  });

  it('reports unavailable with a reason when a pass throws', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { corpus } = corpusOn(h.root);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValue(new Error('EACCES'));
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('EACCES'),
    });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('corpus unavailable for vault "v" (profile "p")'),
    );
  });

  it('recovers from a failed pass without a restart', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { corpus } = corpusOn(h.root);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('EACCES'));
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p').state).toBe('unavailable');
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(1);
  });

  it('coalesces pass requests arriving during a pass', async () => {
    const held = gate();
    const lock = scriptedLock((call) => (call === 1 ? { gate: held.promise } : {}));
    const h = await harness({ 'a.md': body('a') }, { withLock: lock.withLock });
    const { corpus } = corpusOn(h.root);
    const inFlight = lock.nextCall();
    h.loop.addProfile(profileOf('p', corpus));
    await inFlight;
    h.loop.requestPass();
    h.loop.requestPass();
    held.open(); // finish the pass the first request started
    await h.loop.whenSettled();
    expect(lock.calls()).toBe(2); // the first request's pass + one coalesced follow-up
  });

  it('stops scheduling passes after dispose', async () => {
    const h = await harness({ 'a.md': body('a') });
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.lock.calls()).toBe(1);
    await h.loop.dispose();
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(h.lock.calls()).toBe(1);
  });

  it('announces an incompatible corpus on stderr, naming both identities', async () => {
    const h = await harness({ 'a.md': body('a') }, { vaultName: 'Notes' });
    const { store, corpus } = corpusOn(h.root);
    await seed(
      store,
      { 'a.md': body('a') },
      { identity: { ...TEST_IDENTITY, model_key: 'other', embed_version: 99 } },
    );
    const load = vi.spyOn(corpus, 'load');
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    // Vectors of another identity are never read into memory, let alone served.
    expect(load).not.toHaveBeenCalled();
    const announcement =
      'neuro-vault corpus: vault "Notes" (profile "p") was indexed with other (embed_version 99); active model is bge-micro-v2 (embed_version 2) — discarding the corpus and re-indexing in the background';
    expect(h.warn).toHaveBeenCalledWith(announcement);
    expect(h.warn.mock.calls.filter(([m]) => m === announcement)).toHaveLength(1);
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it.each([
    ['a compatible corpus', true],
    ['an empty corpus', false],
  ])('does not announce %s', async (_name, seeded) => {
    const files = { 'a.md': body('a'), 'b.md': body('b') };
    const h = await harness(files, { vaultName: 'Notes' });
    const { store, corpus } = corpusOn(h.root);
    if (seeded) await seed(store, files);
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.warn.mock.calls.flat().join('\n')).not.toContain('was indexed with');
  });

  it('refreshes after a pass that waited for another process, even with nothing changed', async () => {
    const files = { 'a.md': body('a') };
    const lock = scriptedLock(() => ({ waited: true }));
    const h = await harness(files, { withLock: lock.withLock });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    const load = vi.spyOn(corpus, 'load');
    const refresh = vi.spyOn(corpus, 'refresh');
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(load).toHaveBeenCalledTimes(2); // startup load + the refresh after the waited pass
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'a pass after `index --prune` removed the served model directory keeps serving (waited: %s)',
    async (waited) => {
      const files = { 'a.md': body('a'), 'b.md': body('b') };
      const prune: { root?: string } = {};
      const lock = scriptedLock((call) =>
        call === 1
          ? {}
          : {
              waited,
              // `index --model other --prune` removed this model's directory before the pass.
              before: async () => {
                if (prune.root) {
                  await rm(modelCorpusDir(prune.root, TEST_IDENTITY.model_key), {
                    recursive: true,
                    force: true,
                  });
                }
              },
            },
      );
      const h = await harness(files, { withLock: lock.withLock });
      prune.root = h.root;
      const { store, corpus } = corpusOn(h.root);
      await seed(store, files);
      const embed = vi.fn(okEmbed);
      h.loop.addProfile(profileOf('p', corpus, { embed }));
      await h.loop.whenSettled();
      const before = await store.listShards();

      h.loop.requestPass();
      await h.loop.whenSettled();

      expect(lock.calls()).toBe(2);
      expect(h.loop.status('p')).toEqual({ state: 'ready' });
      expect(corpus.size()).toBe(2);
      expect(Array.from(corpus.vectorOf('a.md') ?? [])[0]).toBeCloseTo(0.1);
      expect(embed).not.toHaveBeenCalled();
      // Written back from memory, so a reload after a restart serves the same corpus.
      expect(await store.listShards()).toEqual(before);
    },
  );

  it('keeps serving through a lock timeout and retries on the backoff', async () => {
    const files = { 'a.md': body('a'), 'b.md': body('b') };
    const timers: Timers = [];
    const lock = scriptedLock((call) => (call === 1 ? { throws: lockTimeout() } : {}));
    const h = await harness(files, {
      withLock: lock.withLock,
      retryBaseMs: 1_000,
      ...fakeTimers(timers),
    });
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    h.loop.addProfile(profileOf('p', corpus));

    await h.loop.whenSettled();

    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(2);
    const logged = h.warn.mock.calls.flat().join('\n');
    expect(logged).toContain('pid 4242');
    expect(logged).toContain('reconcile.lock');
    expect(logged).toContain('"v"');
    expect(timers.map((t) => t.ms)).toEqual([1_000]);

    timers[0].fn();
    await h.loop.whenSettled();
    expect(lock.calls()).toBe(2);
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it('stays unavailable, with its reason, when a retry pass times out on the lock', async () => {
    const timers: Timers = [];
    const held = gate();
    const lock = scriptedLock((call) =>
      call === 2 ? { gate: held.promise, throws: lockTimeout() } : {},
    );
    const h = await harness(
      { 'a.md': body('a') },
      { withLock: lock.withLock, retryBaseMs: 1_000, ...fakeTimers(timers) },
    );
    const { corpus } = corpusOn(h.root);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('no model on disk'));
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    const unavailable = h.loop.status('p');
    expect(unavailable).toMatchObject({ state: 'unavailable' });

    const waiting = lock.nextCall();
    timers[0].fn(); // the retry pass switches to `indexing` while it runs, then times out
    await waiting;
    expect(h.loop.status('p')).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    held.open();
    await h.loop.whenSettled();

    expect(h.loop.status('p')).toEqual(unavailable);
    expect(timers).toHaveLength(2); // re-armed again
  });

  it('does not refresh after a pass that did not wait and changed nothing', async () => {
    const files = { 'a.md': body('a') };
    const h = await harness(files);
    const { store, corpus } = corpusOn(h.root);
    await seed(store, files);
    const load = vi.spyOn(corpus, 'load');
    const refresh = vi.spyOn(corpus, 'refresh');
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(load).toHaveBeenCalledTimes(1); // the startup load only
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stays indexing, not unavailable, when a cold vault’s pass times out on the lock', async () => {
    const timers: Timers = [];
    const lock = scriptedLock(() => ({ throws: lockTimeout() }));
    const h = await harness(
      { 'a.md': body('a') },
      { withLock: lock.withLock, retryBaseMs: 1_000, ...fakeTimers(timers) },
    );
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(timers).toHaveLength(1);
  });
});

/**
 * `reconcileProfile` is deliberately per-note tolerant: a rejected `embedDocuments`
 * is counted in `summary.failed`, warned about, and the pass returns normally.
 * "The pass did not throw" is therefore not the same as "the index is good", so
 * these tests drive the real reconcile, the real lock and real corpora on disk.
 */
describe('createReconcileLoop over a real reconcile', () => {
  const failingEmbed: EmbedDocumentsFn = () => {
    throw new Error('ONNX model failed to load');
  };

  /** A cold vault on disk, wired to the production lock; the embedder is swappable. */
  async function coldVault(files: Record<string, string>, over: Partial<IReconcileLoopDeps> = {}) {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-loop-real-'));
    roots.push(root);
    const vault = fakeVault(files);
    const warn = vi.fn();
    let embed: EmbedDocumentsFn = failingEmbed;
    const loop = createReconcileLoop({
      vaultRoot: root,
      vaultName: 'v',
      scan: async () => vault.paths(),
      stat: vault.stat,
      readNote: vault.readNote,
      warn,
      ...over,
    });
    loops.push(loop);
    const { corpus } = corpusOn(root);
    return {
      loop,
      warn,
      corpus,
      root,
      attach: () => loop.addProfile(profileOf('p', corpus, { embed: (texts) => embed(texts) })),
      repairEmbed: () => {
        embed = okEmbed;
      },
      setEmbed: (next: EmbedDocumentsFn) => {
        embed = next;
      },
    };
  }

  it('a vault deleted mid-pass is unavailable after the follow-up pass and never recreated', async () => {
    const files = { 'a.md': body('a'), 'b.md': body('b') };
    const { loop, corpus, attach, root, setEmbed } = await coldVault(files);
    // The watcher's unlink events land while the pass is still embedding.
    setEmbed(async (texts) => {
      await rm(root, { recursive: true, force: true });
      loop.requestPass();
      return texts.map(() => vec(0.1));
    });
    attach();
    await loop.whenSettled();

    expect(loop.status('p')).toMatchObject({ state: 'unavailable' });
    await expect(access(root)).rejects.toThrow();
    expect(corpus.size()).toBe(0);
  });

  it('reports unavailable when every note of a cold vault fails to embed', async () => {
    const { loop, warn, corpus, attach } = await coldVault({
      'a.md': body('a'),
      'b.md': body('b'),
    });
    attach();
    await loop.whenSettled();
    // Not `ready`: the pass wrote no shard, so there is nothing to serve — and
    // not `disabled`, which is reserved for a deliberate opt-out.
    expect(loop.status('p').state).toBe('unavailable');
    expect(loop.status('p').reason).toBeTruthy();
    expect(corpus.size()).toBe(0);
    // The loop's own warning — reconcile's per-note warnings say "failed to index".
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('corpus unavailable for vault "v" (profile "p")'),
    );
  });

  it('stays unavailable when the only note that indexed is below the size gate', async () => {
    // `stub.md` is under MIN_CHARS: it gets no note vector and no qualifying
    // block, so `embedNote` calls `embedDocuments` zero times, writes a record
    // with `embedding: null`, and still counts as `embedded` — while giving the
    // corpus nothing that can rank. A guard that required `embedded === 0`
    // would stay silent on this routine vault shape.
    const { loop, corpus, attach } = await coldVault({
      'stub.md': '# stub\n',
      'a.md': body('a'),
      'b.md': body('b'),
    });
    attach();
    await loop.whenSettled();
    expect(loop.status('p').state).toBe('unavailable');
    expect(corpus.size()).toBe(0);

    // The next pass reuses the stub and changes nothing; the guard must still hold.
    loop.requestPass();
    await loop.whenSettled();
    expect(loop.status('p').state).toBe('unavailable');
    expect(corpus.size()).toBe(0);
  });

  it('promotes to ready once a later pass can embed again', async () => {
    const { loop, corpus, attach, repairEmbed } = await coldVault({
      'a.md': body('a'),
      'b.md': body('b'),
    });
    attach();
    await loop.whenSettled();
    expect(loop.status('p').state).toBe('unavailable');

    repairEmbed();
    loop.requestPass();
    await loop.whenSettled();

    expect(loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(2);
    expect(corpus.vectorOf('a.md')).not.toBeNull();
    expect(corpus.vectorOf('b.md')).not.toBeNull();
  });

  it('reports ready for an empty vault, which has nothing to fail at', async () => {
    const { loop, corpus, attach } = await coldVault({});
    attach();
    await loop.whenSettled();
    expect(loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(0);
  });

  it('reports ready when only some notes fail and the rest are served', async () => {
    const files = { 'good.md': body('good'), 'bad.md': body('bad') };
    const vault = fakeVault(files);
    const { loop, corpus, attach, repairEmbed } = await coldVault(files, {
      readNote: async (p) => {
        if (p === 'bad.md') throw new Error('EACCES');
        return vault.readNote(p);
      },
    });
    repairEmbed();
    attach();
    await loop.whenSettled();
    expect(loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(1);
    expect(corpus.vectorOf('good.md')).not.toBeNull();
  });

  it('re-enters indexing, with counters, while rebuilding after a failure', async () => {
    const timers: Timers = [];
    const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [`${n}.md`, body(n)]));
    const h = await harness(files, { retryBaseMs: 1_000, ...fakeTimers(timers) });
    const { corpus } = corpusOn(h.root);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('boom'));
    const during: unknown[] = [];
    h.loop.addProfile(
      profileOf('p', corpus, {
        embed: async (texts) => {
          during.push(h.loop.status('p'));
          return okEmbed(texts);
        },
      }),
    );

    await h.loop.whenSettled();
    expect(h.loop.status('p').state).toBe('unavailable');

    timers[0].fn();
    await h.loop.whenSettled();

    // A rebuild in flight is a build in flight — reporting `unavailable` across
    // it would tell the caller to start a second, competing indexer.
    expect(during[0]).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(during[2]).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it('retries a failed pass on its own, with no vault change to trigger it', async () => {
    const timers: Timers = [];
    const h = await harness({ 'a.md': body('a') }, { retryBaseMs: 1_000, ...fakeTimers(timers) });
    const { corpus } = corpusOn(h.root);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('no model on disk'));
    h.loop.addProfile(profileOf('p', corpus));

    await h.loop.whenSettled();
    // The watcher is the only other caller of `requestPass()`, so without this
    // timer a vault nobody edits would stay broken until the process restarts.
    expect(timers.map((t) => t.ms)).toEqual([1_000]);

    timers[0].fn();
    await h.loop.whenSettled();

    expect(h.lock.calls()).toBe(2);
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    // A recovered vault starts its backoff over rather than staying at 2s.
    expect(timers).toHaveLength(1);
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('no model on disk'));
    h.loop.requestPass();
    await h.loop.whenSettled();
    expect(timers.map((t) => t.ms)).toEqual([1_000, 1_000]);
  });

  it('aborts the pass in flight when disposed', async () => {
    const started = gate();
    let seen: AbortSignal | undefined;
    // Settles only on abort: a cold index is thousands of reads and embeds,
    // and nothing else would stop them once the client hung up.
    const withLock = (async (_root: string, opts: ILockedPassOptions) => {
      seen = opts.signal;
      started.open();
      await new Promise((resolve) => opts.signal?.addEventListener('abort', resolve));
      return undefined;
    }) as typeof withReconcileLock;
    const h = await harness({ 'a.md': body('a') }, { withLock });
    const { corpus } = corpusOn(h.root);
    h.loop.addProfile(profileOf('p', corpus));

    await started.promise;
    await h.loop.dispose();
    await h.loop.whenSettled();

    expect(seen?.aborted).toBe(true);
    // A disposed pass promotes nothing — its summary is partial by construction.
    expect(h.loop.status('p').state).not.toBe('ready');
  });
});

describe('createReconcileLoop, many profiles', () => {
  /** Two profiles over one vault, each embedding through its own recorded embedder. */
  async function twoProfiles(
    files: Record<string, string>,
    over: Partial<IReconcileLoopDeps> = {},
    opts: { seeded?: boolean } = {},
  ) {
    const h = await harness(files, over);
    const first = corpusOn(h.root, TEST_IDENTITY);
    const second = corpusOn(h.root, SECOND_IDENTITY);
    if (opts.seeded) {
      await seed(first.store, files);
      await seed(second.store, files, { identity: SECOND_IDENTITY });
    }
    const order: string[] = [];
    const recorded =
      (key: string): EmbedDocumentsFn =>
      async (texts) => {
        order.push(key);
        return okEmbed(texts);
      };
    return {
      ...h,
      first,
      second,
      order,
      profiles: {
        a: profileOf('a', first.corpus, { embed: recorded('a') }),
        b: profileOf('b', second.corpus, { identity: SECOND_IDENTITY, embed: recorded('b') }),
      },
    };
  }

  it('one lock acquisition for two profiles', async () => {
    const t = await twoProfiles({ 'n1.md': body('1'), 'n2.md': body('2') });
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    t.loop.requestPass();
    await t.loop.whenSettled();
    expect(t.lock.calls()).toBe(1);
    expect(t.order).toEqual(['a', 'a', 'b', 'b']);
    expect(t.first.corpus.size()).toBe(2);
    expect(t.second.corpus.size()).toBe(2);
    expect(t.loop.status('a')).toEqual({ state: 'ready' });
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
  });

  it('a profile added mid-pass is built by the next pass', async () => {
    const held = gate();
    const lock = scriptedLock((call) => (call === 1 ? { gate: held.promise } : {}));
    const t = await twoProfiles({ 'n1.md': body('1') }, { withLock: lock.withLock });
    const inFlight = lock.nextCall();
    t.loop.addProfile(t.profiles.a);
    await inFlight;
    t.loop.addProfile(t.profiles.b);
    held.open();
    await t.loop.whenSettled();
    expect(lock.calls()).toBe(2);
    expect(t.order).toEqual(['a', 'b']);
    expect(t.second.corpus.size()).toBe(1);
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
  });

  it('a pass that waited refreshes every corpus', async () => {
    const files = { 'n1.md': body('1') };
    const lock = scriptedLock(() => ({ waited: true }));
    const t = await twoProfiles(files, { withLock: lock.withLock }, { seeded: true });
    const refreshA = vi.spyOn(t.first.corpus, 'refresh');
    const refreshB = vi.spyOn(t.second.corpus, 'refresh');
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual([]);
  });

  it('a pass that waited serves the other holder’s vectors without embedding again', async () => {
    const files = { 'n1.md': body('1') };
    const edited = body('edited');
    const other: { store?: ShardStore } = {};
    const lock = scriptedLock((call) =>
      call === 1
        ? {}
        : {
            waited: true,
            // `neuro-vault-mcp index` re-embedded the edited note while this pass waited.
            before: async () => {
              if (other.store)
                await seed(other.store, { 'n1.md': edited }, { fill: 0.9, mtime: 2 });
            },
          },
    );
    const t = await twoProfiles(files, { withLock: lock.withLock }, { seeded: true });
    other.store = t.first.store;
    t.loop.addProfile(t.profiles.a);
    await t.loop.whenSettled();

    t.vault.edit('n1.md', edited);
    t.loop.requestPass();
    await t.loop.whenSettled();

    expect(t.order).toEqual([]);
    expect(t.first.corpus.vectorOf('n1.md')?.[0]).toBeCloseTo(0.9);
  });

  it('setScope during a pass queues one pass', async () => {
    const held = gate();
    const lock = scriptedLock((call) => (call === 1 ? { gate: held.promise } : {}));
    const t = await twoProfiles({ 'n1.md': body('1') }, { withLock: lock.withLock });
    const inFlight = lock.nextCall();
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await inFlight;
    t.loop.requestPass(); // the scope swap
    t.loop.requestPass(); // the watcher restart's own request
    held.open();
    await t.loop.whenSettled();
    expect(lock.calls()).toBe(2);
    expect(t.scan).toHaveBeenCalledTimes(2);
  });

  it('the empty-corpus guard per profile', async () => {
    const t = await twoProfiles({ 'n1.md': body('1'), 'n2.md': body('2') });
    t.loop.addProfile({
      ...t.profiles.a,
      embedDocuments: () => Promise.reject(new Error('ONNX model failed to load')),
    });
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    expect(t.loop.status('a')).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('indexing produced no usable corpus: 2 of 2 notes failed'),
    });
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
    expect(t.second.corpus.size()).toBe(2);
  });

  it('a profile whose reconcile throws does not stop the next one', async () => {
    const t = await twoProfiles({ 'n1.md': body('1') });
    vi.spyOn(t.first.corpus, 'ensureIdentity').mockRejectedValue(new Error('EACCES'));
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    expect(t.loop.status('a')).toMatchObject({ state: 'unavailable', reason: 'Error: EACCES' });
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
    expect(t.warn).toHaveBeenCalledWith(
      'neuro-vault semantic: corpus unavailable for vault "v" (profile "a"): Error: EACCES',
    );
  });

  it('a lock timeout restores every profile and warns once', async () => {
    const timers: Timers = [];
    const lock = scriptedLock((call) => (call === 2 ? { throws: lockTimeout() } : {}));
    const t = await twoProfiles(
      { 'n1.md': body('1') },
      { withLock: lock.withLock, retryBaseMs: 1_000, ...fakeTimers(timers) },
    );
    vi.spyOn(t.second.corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('EACCES'));
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    const before = t.loop.status('b');
    expect(before.state).toBe('unavailable');

    timers[0].fn();
    await t.loop.whenSettled();

    expect(t.loop.status('a')).toEqual({ state: 'ready' });
    expect(t.loop.status('b')).toEqual(before);
    expect(t.warn.mock.calls.filter(([m]) => String(m).includes('still held by'))).toHaveLength(1);
    expect(timers.map((x) => x.ms)).toEqual([1_000, 2_000]);
  });

  it('a disabled profile is skipped while the others are built', async () => {
    const t = await twoProfiles({ 'n1.md': body('1') });
    t.loop.addProfile({ ...t.profiles.a, enabled: false });
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    expect(t.loop.status('a')).toEqual({ state: 'disabled' });
    expect(t.first.corpus.loaded).toBe(false);
    expect(t.order).toEqual(['b']);
  });

  it('skips a profile removed before the pass reached it', async () => {
    const held = gate();
    const reached = gate();
    const t = await twoProfiles({ 'n1.md': body('1') });
    t.loop.addProfile({
      ...t.profiles.a,
      embedDocuments: async (texts) => {
        reached.open();
        await held.promise;
        return okEmbed(texts);
      },
    });
    t.loop.addProfile(t.profiles.b);
    await reached.promise;
    t.loop.removeProfile('b');
    held.open();
    await t.loop.whenSettled();
    expect(t.order).toEqual([]);
    expect(t.loop.status('a')).toEqual({ state: 'ready' });
    expect(() => t.loop.status('b')).toThrow(/unknown profile "b"/);
  });

  it('stops a profile removed mid-reconcile after its note in flight, then drops its outcome', async () => {
    const held = gate();
    const reached = gate();
    const t = await twoProfiles({ 'n1.md': body('1'), 'n2.md': body('2'), 'n3.md': body('3') });
    let embedsA = 0;
    let finished = false;
    t.loop.addProfile({
      ...t.profiles.a,
      embedDocuments: async (texts) => {
        embedsA += 1;
        reached.open();
        await held.promise;
        finished = true;
        return okEmbed(texts);
      },
    });
    t.loop.addProfile(t.profiles.b);
    await reached.promise;
    t.loop.removeProfile('a');
    held.open();
    await t.loop.whenSettled();
    // The note in flight finishes; the two after the removal are never embedded.
    expect(finished).toBe(true);
    expect(embedsA).toBe(1);
    expect(() => t.loop.lastReconcile('a')).toThrow(/unknown profile "a"/);
    expect(t.order).toEqual(['b', 'b', 'b']);
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
  });

  it('records the last reconcile per profile', async () => {
    let clock = 1_000;
    const t = await twoProfiles(
      { 'n1.md': body('1'), 'n2.md': body('2'), 'n3.md': body('3') },
      { now: () => (clock += 5) },
    );
    t.loop.addProfile(t.profiles.a);
    expect(t.loop.lastReconcile('a')).toBeUndefined();
    await t.loop.whenSettled();
    expect(t.loop.lastReconcile('a')).toEqual({
      at: new Date(1_010).toISOString(),
      added: 3,
      changed: 0,
      removed: 0,
      ms: 5,
    });

    t.vault.edit('n1.md', body('1 edited'));
    t.vault.remove('n3.md');
    t.vault.remove('n2.md');
    t.vault.edit('moved.md', body('2')); // n2.md renamed: same bytes, new path
    t.loop.requestPass();
    await t.loop.whenSettled();
    expect(t.loop.lastReconcile('a')).toMatchObject({ added: 0, changed: 2, removed: 1, ms: 5 });
  });

  it('dispose aborts the reconcile in flight and runs nothing afterwards', async () => {
    const held = gate();
    const reached = gate();
    const t = await twoProfiles({ 'n1.md': body('1'), 'n2.md': body('2') });
    let embedsA = 0;
    t.loop.addProfile({
      ...t.profiles.a,
      embedDocuments: async (texts) => {
        embedsA += 1;
        reached.open();
        await held.promise;
        return okEmbed(texts);
      },
    });
    t.loop.addProfile(t.profiles.b);
    await reached.promise;
    const disposing = t.loop.dispose();
    held.open();
    await disposing;
    // Stopped at the next note boundary; the second profile never ran.
    expect(embedsA).toBe(1);
    expect(t.order).toEqual([]);
    expect(t.loop.lastReconcile('a')).toBeUndefined();
    expect(t.loop.status('a').state).not.toBe('ready');
    t.loop.requestPass();
    await t.loop.whenSettled();
    expect(t.lock.calls()).toBe(1);
  });

  it('runs no pass when disposed in the tick that requested it', async () => {
    const t = await twoProfiles({ 'n1.md': body('1') });
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.dispose();
    await t.loop.whenSettled();
    expect(t.lock.calls()).toBe(0);
    expect(t.scan).not.toHaveBeenCalled();
    expect(t.order).toEqual([]);
  });

  it('labels per-note warnings with the profile', async () => {
    const files = { 'n1.md': body('1') };
    const t = await twoProfiles(files, {
      readNote: async (p) => {
        throw new Error(`EACCES ${p}`);
      },
    });
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    const perNote = t.warn.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.includes('failed to index "n1.md"'));
    expect(perNote).toHaveLength(2);
    expect(perNote[0]).toMatch(/^\[profile "a"\] neuro-vault corpus: failed to index/);
    expect(perNote[1]).toMatch(/^\[profile "b"\] neuro-vault corpus: failed to index/);
  });

  it('calls onSettled after each selection and after each profile a pass reconciled', async () => {
    const calls: Array<{ key: string; loaded: boolean }> = [];
    const files = { 'n1.md': body('1') };
    const corpora = new Map<string, ShardCorpus>();
    const t = await twoProfiles(
      files,
      { onSettled: (key) => calls.push({ key, loaded: corpora.get(key)?.loaded ?? false }) },
      { seeded: true },
    );
    corpora.set('a', t.first.corpus).set('b', t.second.corpus);
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    t.loop.addProfile(profileOf('off', corpusOn(t.root).corpus, { enabled: false }));
    await t.loop.whenSettled();
    // Each profile once for its selection and once for the pass; the pass walks
    // them in attach order, but b's selection may land after a's pass. Never the disabled one.
    const keys = calls.map((c) => c.key);
    expect(keys.filter((k) => k === 'a')).toHaveLength(2);
    expect(keys.filter((k) => k === 'b')).toHaveLength(2);
    expect(keys).toHaveLength(4);
    expect(keys.lastIndexOf('a')).toBeLessThan(keys.lastIndexOf('b'));
    expect(calls.every((c) => c.loaded)).toBe(true);
  });

  it('warns about a throwing onSettled and keeps going', async () => {
    const t = await twoProfiles(
      { 'n1.md': body('1') },
      {
        onSettled: () => {
          throw new Error('hook broke');
        },
      },
    );
    t.loop.addProfile(t.profiles.a);
    t.loop.addProfile(t.profiles.b);
    await t.loop.whenSettled();
    expect(t.loop.status('a')).toEqual({ state: 'ready' });
    expect(t.loop.status('b')).toEqual({ state: 'ready' });
    const hookWarnings = t.warn.mock.calls
      .map(([m]) => String(m))
      .filter((m) => /hook broke/.test(m));
    expect(hookWarnings.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects an unknown key and a duplicate profile', async () => {
    const t = await twoProfiles({});
    expect(() => t.loop.status('nope')).toThrow(/unknown profile "nope"/);
    t.loop.addProfile(t.profiles.a);
    expect(() => t.loop.addProfile(t.profiles.a)).toThrow(/already/);
    await t.loop.whenSettled();
  });
});

/** Records matching `notes` as the fake vault reports them, under `identity`. */
function memorySeeded(
  notes: Record<string, string>,
  opts: { identity?: CorpusIdentity; fill?: number } = {},
): IMemoryStore {
  const store = memoryStore();
  store.identity = { ...(opts.identity ?? TEST_IDENTITY) };
  for (const [notePath, content] of Object.entries(notes)) {
    store.records.set(notePath, {
      path: notePath,
      content_hash: contentHash(content),
      mtime: 1,
      size: content.length,
      embedding: encodeVector(vec(opts.fill ?? 0.1)),
      blocks: [],
    });
  }
  return store;
}

// The loop sees only ICorpus: these run it over a corpus with no shard anywhere.
describe('createReconcileLoop over an in-memory corpus', () => {
  it('builds a cold corpus and serves it, writing nothing under .neuro-vault/', async () => {
    const h = await harness({ 'a.md': body('a'), 'b.md': body('b') });
    const corpus = new MemoryCorpus();
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(corpus.size()).toBe(2);
    expect(corpus.store.identity).toEqual(TEST_IDENTITY);
    expect(h.loop.lastReconcile('p')).toMatchObject({ added: 2, changed: 0, removed: 0 });
    await expect(access(path.join(h.root, '.neuro-vault'))).rejects.toThrow();
  });

  it('serves a compatible corpus at its startup selection, before the pass', async () => {
    const files = { 'a.md': body('a') };
    const held = gate();
    const lock = scriptedLock(() => ({ gate: held.promise }));
    const h = await harness(files, { withLock: lock.withLock });
    const embed = vi.fn(okEmbed);
    h.loop.addProfile(profileOf('p', new MemoryCorpus(memorySeeded(files)), { embed }));
    await vi.waitFor(() => expect(h.loop.status('p')).toEqual({ state: 'ready' }));
    held.open();
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
    expect(embed).not.toHaveBeenCalled();
  });

  it('announces and rebuilds a corpus recorded under another identity', async () => {
    const files = { 'a.md': body('a') };
    const h = await harness(files);
    const corpus = new MemoryCorpus(memorySeeded(files, { identity: SECOND_IDENTITY, fill: 0.9 }));
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.warn).toHaveBeenCalledWith(
      'neuro-vault corpus: vault "v" (profile "p") was indexed with second-model ' +
        '(embed_version 2); active model is bge-micro-v2 (embed_version 2) — ' +
        'discarding the corpus and re-indexing in the background',
    );
    expect(corpus.store.identity).toEqual(TEST_IDENTITY);
    expect(corpus.vectorOf('a.md')?.[0]).toBeCloseTo(0.1);
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });

  it('follows edits and removals through the corpus writes', async () => {
    const files = { 'a.md': body('a'), 'b.md': body('b') };
    const h = await harness(files);
    const corpus = new MemoryCorpus(memorySeeded(files));
    const embed = vi.fn(okEmbed);
    h.loop.addProfile(profileOf('p', corpus, { embed }));
    await h.loop.whenSettled();
    expect(embed).not.toHaveBeenCalled();

    h.vault.edit('a.md', body('edited'));
    h.vault.remove('b.md');
    h.loop.requestPass();
    await h.loop.whenSettled();

    expect(embed).toHaveBeenCalledTimes(1);
    expect([...(await corpus.entries()).keys()]).toEqual(['a.md']);
    expect((await corpus.entries()).get('a.md')?.content_hash).toBe(contentHash(body('edited')));
    expect(h.loop.lastReconcile('p')).toMatchObject({ added: 0, changed: 1, removed: 1 });
  });

  it('a pass that waited refreshes the corpus before reconciling it', async () => {
    const files = { 'a.md': body('a') };
    const lock = scriptedLock(() => ({ waited: true }));
    const h = await harness(files, { withLock: lock.withLock });
    const corpus = new MemoryCorpus(memorySeeded(files));
    const refresh = vi.spyOn(corpus, 'refresh');
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a corpus that throws makes the profile unavailable and is retried', async () => {
    const timers: Timers = [];
    const h = await harness({ 'a.md': body('a') }, fakeTimers(timers));
    const corpus = new MemoryCorpus();
    vi.spyOn(corpus, 'ensureIdentity').mockRejectedValueOnce(new Error('store unreachable'));
    h.loop.addProfile(profileOf('p', corpus));
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toMatchObject({
      state: 'unavailable',
      reason: 'Error: store unreachable',
    });

    timers[0].fn();
    await h.loop.whenSettled();
    expect(h.loop.status('p')).toEqual({ state: 'ready' });
  });
});
