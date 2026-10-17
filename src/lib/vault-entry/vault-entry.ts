import type { CorpusAnchor, ICorpusReader } from '../obsidian/corpus/corpus.js';
import { buildReconcileFsDeps, type ReconcileFsDeps } from '../obsidian/corpus/fs-deps.js';
import { corpusIdentityOf, type CorpusIdentity } from '../obsidian/corpus/identity.js';
import { ShardCorpus } from '../obsidian/corpus/shard-corpus.js';
import { ShardStore } from '../obsidian/corpus/shard-store.js';
import type { EmbedDocumentsFn } from '../obsidian/corpus/types.js';
import type { BackendState, BackendStatus } from '../obsidian/semantic-backend.js';
import { FsVaultReader } from '../obsidian/vault-reader.js';
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

export interface IVaultInfo {
  vault: string;
  clients: number;
  idle_since?: string;
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
  let fsDeps: ReconcileFsDeps = fsDepsFor(scope);
  /** In attach order: the order `info()` lists them. */
  const slots = new Map<string, IProfileSlot>();
  /** Watchers being closed after a scope change; dispose waits for them. */
  const closing = new Set<Promise<void>>();
  let disposing: Promise<void> | null = null;

  function fsDepsFor(next: VaultScope): ReconcileFsDeps {
    return buildReconcileFsDeps({
      vaultRoot,
      reader: new FsVaultReader({ vaultRoot, scope: next }),
    });
  }

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

  let watcher = startWatcher();

  function startWatcher(): WatcherHandle {
    // startVaultWatcher contains its own failures: a vault without a watcher
    // still reconciles on every attach (VaultEntries asks for a pass on each).
    return startVaultWatcher({
      vaultRoot,
      vaultName,
      scope,
      onQuiet: () => loop.requestPass(),
      debounceMs: opts.debounceMs,
      createWatcher: opts.createWatcher,
      warn,
    });
  }

  /** Swaps in a watcher over the current scope; the old one closes in the background. */
  function restartWatcher(): void {
    if (disposing !== null) return;
    const previous = watcher;
    watcher = startWatcher();
    const closed = closeWatcher(previous).finally(() => closing.delete(closed));
    closing.add(closed);
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
  }

  function detachCorpus(slot: IProfileSlot): void {
    if (slot.corpus === null) return;
    loop.removeProfile(slot.key);
    slot.corpus.dispose();
    slot.corpus = null;
    slot.excluded = [];
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
   * anchor on an excluded note — what the session's snapshot answers, as an
   * excluded note is not in it. Such a note can still be in the corpus until a
   * pass sweeps it, and its vector would otherwise anchor a search.
   */
  async function foldAnchors<T>(
    anchors: readonly CorpusAnchor[],
    read: (kept: readonly CorpusAnchor[]) => Promise<(T | null)[]>,
  ): Promise<(T | null)[]> {
    const excluded = (anchor: CorpusAnchor) => 'path' in anchor && scope.isExcluded(anchor.path);
    if (!anchors.some(excluded)) return read(anchors);
    const answers = await read(anchors.filter((anchor) => !excluded(anchor)));
    let next = 0;
    return anchors.map((anchor) => (excluded(anchor) ? null : answers[next++]));
  }

  function status(key: string): BackendStatus {
    return slotOf(key).corpus === null ? { state: 'disabled' } : loop.status(key);
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
      fsDeps = fsDepsFor(next);
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
        ...(clients === 0 && idleSince !== undefined ? { idle_since: idleSince } : {}),
        profiles,
      };
    },
    dispose() {
      disposing ??= (async () => {
        // The loop is aborted at once, beside the watcher close: the pass in flight
        // holds the vault's reconcile lock until it stops. closeWatcher never rejects.
        await Promise.all([closeWatcher(watcher), ...closing, loop.dispose()]);
        for (const slot of slots.values()) slot.corpus?.dispose();
      })();
      return disposing;
    },
  };
}
