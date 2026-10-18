import type { CorpusAnchor, ICorpusReader } from '../obsidian/corpus/corpus.js';
import { buildReconcileFsDeps, type ReconcileFsDeps } from '../obsidian/corpus/fs-deps.js';
import { corpusIdentityOf, type CorpusIdentity } from '../obsidian/corpus/identity.js';
import { ShardCorpus } from '../obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../obsidian/corpus/shard-store.js';
import type { EmbedDocumentsFn } from '../obsidian/corpus/types.js';
import { LexicalIndex } from '../obsidian/lexical/lexical-index.js';
import type { ILexicalResult, ILexicalSearchOptions } from '../obsidian/lexical/reader.js';
import type { BackendState, BackendStatus } from '../obsidian/semantic-backend.js';
import { FsVaultReader } from '../obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../obsidian/wikilink-graph.js';
import type { VaultScope } from '../obsidian/vault-scope.js';
import { identityOf, MODEL_PROFILES } from '../model-profiles.js';
import {
  createReconcileLoop,
  type ILastReconcile,
  type IReconcileLoop,
  type IReconcileLoopDeps,
} from './reconcile-loop.js';
import { startVaultWatcher, type WatcherFactory, type WatcherHandle } from './watcher.js';

export interface IProfileInfo {
  profile: string;
  state: BackendState;
  indexed?: number;
  total?: number;
  /** Why the corpus cannot be served; present for `unavailable`. */
  reason?: string;
  notes?: number;
  last_reconcile?: ILastReconcile;
}

/** The entry's lexical cache: `warming` until its first refresh completes. */
export interface ILexicalInfo {
  state: 'warming' | 'ready';
  notes?: number;
  last_refresh?: { at: string; parsed: number; ms: number };
}

export interface IVaultInfo {
  vault: string;
  clients: number;
  idle_since?: string;
  lexical: ILexicalInfo;
  profiles: IProfileInfo[];
}

export interface IVaultEntryOptions {
  /** The vault directory's realpath: the entry's key. */
  vaultRoot: string;
  /** For logs only. */
  vaultName: string;
  scope: VaultScope;
  /** The vault's own `semantic` key: false keeps every profile `disabled`. */
  semantic: boolean;
  embedderFor: (profileKey: string) => EmbedDocumentsFn;
  warn: (message: string) => void;
  /** The tie-break graph's TTL; tests shorten or stretch it, production keeps the default. */
  graphTtlMs?: number;
  /** Quiet interval before a change schedules a pass; production keeps the watcher's default. */
  debounceMs?: number;
  /** Injected by tests; production defaults to the chokidar-backed watcher. */
  createWatcher?: WatcherFactory;
  /** Injected by tests; production uses {@link createReconcileLoop}. */
  createLoop?: (deps: IReconcileLoopDeps) => IReconcileLoop;
}

/** One vault directory's shared state (design D1): scope, watcher, loop, a corpus per profile. */
export interface IVaultEntry {
  readonly vaultRoot: string;
  readonly scope: VaultScope;
  readonly semantic: boolean;
  /** Attaches a profile; its corpus loads and builds in the background. */
  addProfile(key: string): void;
  /** Detaches a profile and frees its vectors. */
  removeProfile(key: string): void;
  /** Restarts the watcher, rescopes the reader and every later read, and queues a pass. */
  setScope(scope: VaultScope): void;
  /**
   * Queues a pass; it coalesces with any already queued. Asked on every attach, so
   * an entry whose watcher failed (or never started) still reconciles then.
   */
  requestPass(): void;
  /** Disables every profile (no corpus at all), or gives each a fresh corpus. */
  setSemantic(enabled: boolean): void;
  status(key: string): BackendStatus;
  /** The profile's corpus with the scope folded into every read: candidates and path anchors. */
  reader(key: string): ICorpusReader;
  /**
   * Lexical search over the scoped vault, ranked with the entry's own wikilink graph.
   * Read-through: it never waits on a reconcile pass and never touches the watcher.
   */
  lexicalSearch(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
  lexicalInfo(): ILexicalInfo;
  info(clients: number, idleSince?: string): IVaultInfo;
  dispose(): Promise<void>;
}

/** The corpus identity an entry builds and checks a profile's corpus against. */
export function profileIdentity(key: string): CorpusIdentity {
  return corpusIdentityOf(identityOf(MODEL_PROFILES[key]));
}

interface IProfileSlot {
  key: string;
  identity: CorpusIdentity;
  /** null while the vault is disabled: no store, no corpus, nothing under `.neuro-vault/corpus/`. */
  corpus: ShardCorpus | null;
  /**
   * Corpus paths the scope excludes but no pass has swept yet. A read cannot
   * drop them from its results afterwards — a limit has already been applied —
   * so they ride in its `exclude`.
   */
  excluded: string[];
  /** The recompute in flight; a read waits for it, so a new scope applies to the next read. */
  recomputing: Promise<void> | null;
}

export function createVaultEntry(opts: IVaultEntryOptions): IVaultEntry {
  const { vaultRoot, vaultName, warn } = opts;
  let scope = opts.scope;
  let semantic = opts.semantic;
  /** In attach order: the order `info()` lists them. */
  const slots = new Map<string, IProfileSlot>();
  /** Watchers being closed (scope change, last corpus gone); dispose waits for them. */
  const closing = new Set<Promise<void>>();

  /** The scoped reader behind `fsDeps` and the lexical members: one scan rule for all three. */
  let scopedReader: FsVaultReader = readerFor(scope);
  let fsDeps: ReconcileFsDeps = buildReconcileFsDeps({ vaultRoot, reader: scopedReader });
  /** null once disposed: a later search rejects and the members can be collected. */
  let lexical: LexicalIndex | null = null;
  let graph: WikilinkGraphIndex | null = null;
  let disposing: Promise<void> | null = null;

  function readerFor(next: VaultScope): FsVaultReader {
    return new FsVaultReader({ vaultRoot, scope: next });
  }

  /** A fresh index and graph over the current reader (the graph's build time starts at 0). */
  function buildLexical(): void {
    lexical = new LexicalIndex({ vaultRoot, reader: scopedReader, warn });
    graph = new WikilinkGraphIndex({ reader: scopedReader, ttlMs: opts.graphTtlMs });
    // warm never rejects; searches arriving meanwhile share its refresh.
    void lexical.warm();
  }
  buildLexical();

  const loop = (opts.createLoop ?? createReconcileLoop)({
    vaultRoot,
    vaultName,
    // Through the current deps, so a scope change reaches the next pass's scan.
    scan: () => fsDeps.scan(),
    stat: (relPath) => fsDeps.stat(relPath),
    readNote: (relPath) => fsDeps.readNote(relPath),
    warn,
    onSettled: (key) => recompute(slots.get(key)),
    onVaultRestored: () => restartWatcher(),
  });

  /** Runs only while some profile holds a corpus (design D3): a corpus-less vault watches nothing. */
  let watcher: WatcherHandle | null = null;

  function startWatcher(): void {
    if (watcher !== null || disposing !== null) return;
    // startVaultWatcher contains its own failures: a vault without a watcher
    // still reconciles on every attach (VaultEntries asks for a pass on each).
    watcher = startVaultWatcher({
      vaultRoot,
      vaultName,
      scope,
      onQuiet: () => loop.requestPass(),
      debounceMs: opts.debounceMs,
      createWatcher: opts.createWatcher,
      warn,
    });
  }

  /** Closes the watcher in the background; dispose waits for it. */
  function stopWatcher(): void {
    const previous = watcher;
    if (previous === null) return;
    watcher = null;
    const closed = closeWatcher(previous).finally(() => closing.delete(closed));
    closing.add(closed);
  }

  /** Swaps in a watcher over the current scope; only a running watcher is restarted. */
  function restartWatcher(): void {
    if (disposing !== null || watcher === null) return;
    stopWatcher();
    startWatcher();
  }

  function hasCorpus(): boolean {
    for (const slot of slots.values()) if (slot.corpus !== null) return true;
    return false;
  }

  function closeWatcher(handle: WatcherHandle): Promise<void> {
    return handle.close().catch((err: unknown) => {
      warn(`neuro-vault watcher: vault "${vaultName}": failed to close: ${String(err)}`);
    });
  }

  function recompute(slot: IProfileSlot | undefined): void {
    const corpus = slot?.corpus;
    if (slot === undefined || !corpus?.loaded) return;
    const run: Promise<void> = corpus
      .entries()
      .then((entries) => {
        // Judged by the scope current when this lands, so a later setScope is never undone.
        if (slot.corpus === corpus) {
          slot.excluded = [...entries.keys()].filter((p) => scope.isExcluded(p));
        }
      })
      .catch((err: unknown) => {
        warn(`neuro-vault corpus: vault "${vaultName}" (profile "${slot.key}"): ${String(err)}`);
      })
      .finally(() => {
        if (slot.recomputing === run) slot.recomputing = null;
      });
    slot.recomputing = run;
  }

  function attachCorpus(slot: IProfileSlot): void {
    const store = new ShardStore(vaultRoot, {
      modelKey: slot.key,
      dims: slot.identity.dims,
      warn,
    });
    slot.corpus = new ShardCorpus(store);
    slot.excluded = [];
    loop.addProfile({
      key: slot.key,
      identity: slot.identity,
      corpus: slot.corpus,
      embedDocuments: opts.embedderFor(slot.key),
      enabled: true,
    });
    startWatcher();
  }

  function detachCorpus(slot: IProfileSlot): void {
    if (slot.corpus === null) return;
    loop.removeProfile(slot.key);
    slot.corpus.dispose();
    slot.corpus = null;
    slot.excluded = [];
    if (!hasCorpus()) stopWatcher();
  }

  function slotOf(key: string): IProfileSlot {
    const slot = slots.get(key);
    if (slot === undefined) throw new Error(`vault entry: profile "${key}" is not attached`);
    return slot;
  }

  function corpusOf(key: string): ShardCorpus {
    const corpus = slotOf(key).corpus;
    if (corpus === null) throw new Error(`vault entry: profile "${key}" is disabled`);
    return corpus;
  }

  /**
   * Runs a read over the anchors the scope keeps and answers `null` for a path
   * anchor on an excluded note — as for a note the corpus does not hold, which
   * is what an excluded note is to every caller. Such a note can still be in the corpus until a
   * pass sweeps it, and its vector would otherwise anchor a search.
   */
  async function foldAnchors<T>(
    anchors: readonly CorpusAnchor[],
    read: (kept: readonly CorpusAnchor[]) => Promise<(T | null)[]>,
  ): Promise<(T | null)[]> {
    // Decided once, before the read: a scope change while it runs must not move the answers
    // off the anchors they belong to.
    const excluded = anchors.map((anchor) => 'path' in anchor && scope.isExcluded(anchor.path));
    if (!excluded.includes(true)) return read(anchors);
    const answers = await read(anchors.filter((_, index) => !excluded[index]));
    let next = 0;
    return excluded.map((skip) => (skip ? null : answers[next++]));
  }

  function status(key: string): BackendStatus {
    return slotOf(key).corpus === null ? { state: 'disabled' } : loop.status(key);
  }

  function lexicalInfo(): ILexicalInfo {
    const info = lexical?.info();
    if (info === undefined || !info.warmed || info.lastRefresh === undefined) {
      return { state: 'warming' };
    }
    const { at, parsed, ms } = info.lastRefresh;
    return {
      state: 'ready',
      notes: info.notes,
      last_refresh: { at: at.toISOString(), parsed, ms },
    };
  }

  return {
    vaultRoot,
    get scope() {
      return scope;
    },
    get semantic() {
      return semantic;
    },
    addProfile(key) {
      if (slots.has(key)) throw new Error(`vault entry: profile "${key}" is already attached`);
      const slot: IProfileSlot = {
        key,
        identity: profileIdentity(key),
        corpus: null,
        excluded: [],
        recomputing: null,
      };
      slots.set(key, slot);
      if (semantic) attachCorpus(slot);
    },
    removeProfile(key) {
      detachCorpus(slotOf(key));
      slots.delete(key);
    },
    setScope(next) {
      if (disposing !== null) return;
      scope = next;
      scopedReader = readerFor(next);
      fsDeps = buildReconcileFsDeps({ vaultRoot, reader: scopedReader });
      buildLexical();
      restartWatcher();
      for (const slot of slots.values()) recompute(slot);
      loop.requestPass();
    },
    setSemantic(enabled) {
      if (disposing !== null || enabled === semantic) return;
      semantic = enabled;
      for (const slot of slots.values()) {
        if (enabled) attachCorpus(slot);
        else detachCorpus(slot);
      }
    },
    requestPass: () => loop.requestPass(),
    status,
    reader(key) {
      slotOf(key);
      return {
        // Resolved per call: the corpus is replaced when the vault is re-enabled.
        nearest: async (anchors, readOpts) => {
          await slotOf(key).recomputing;
          const slot = slotOf(key);
          const corpus = corpusOf(key);
          return foldAnchors(anchors, (kept) =>
            corpus.nearest(kept, {
              ...readOpts,
              allowed: readOpts.allowed?.filter((p) => !scope.isExcluded(p)),
              exclude:
                slot.excluded.length === 0
                  ? readOpts.exclude
                  : [...(readOpts.exclude ?? []), ...slot.excluded],
            }),
          );
        },
        nearestBlocks: async (anchors, readOpts) => {
          const corpus = corpusOf(key);
          return foldAnchors(anchors, (kept) =>
            corpus.nearestBlocks(kept, {
              ...readOpts,
              paths: readOpts.paths.filter((p) => !scope.isExcluded(p)),
            }),
          );
        },
      };
    },
    async lexicalSearch(searchOpts) {
      const index = lexical;
      const links = graph;
      if (index === null || links === null) throw new Error('vault entry: disposed');
      await links.ensureFresh();
      return index.search({ ...searchOpts, getBacklinkCount: (p) => links.getBacklinkCount(p) });
    },
    lexicalInfo,
    info(clients, idleSince) {
      const profiles = [...slots.values()].map((slot): IProfileInfo => {
        const current = status(slot.key);
        const info: IProfileInfo = { profile: slot.key, state: current.state };
        if (current.state === 'indexing') {
          info.indexed = current.indexed;
          info.total = current.total;
        }
        if (current.state === 'unavailable' && current.reason !== undefined) {
          info.reason = current.reason;
        }
        if (current.state === 'ready' && slot.corpus?.loaded) info.notes = slot.corpus.size();
        const last = slot.corpus === null ? undefined : loop.lastReconcile(slot.key);
        if (last !== undefined) info.last_reconcile = last;
        return info;
      });
      return {
        vault: vaultRoot,
        clients,
        lexical: lexicalInfo(),
        ...(clients === 0 && idleSince !== undefined ? { idle_since: idleSince } : {}),
        profiles,
      };
    },
    dispose() {
      lexical = null;
      graph = null;
      disposing ??= (async () => {
        // The loop is aborted at once, beside the watcher close: the pass in flight
        // holds the vault's reconcile lock until it stops. closeWatcher never rejects.
        if (watcher !== null) stopWatcher();
        await Promise.all([...closing, loop.dispose()]);
        for (const slot of slots.values()) slot.corpus?.dispose();
      })();
      return disposing;
    },
  };
}
