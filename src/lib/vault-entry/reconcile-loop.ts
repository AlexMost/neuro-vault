import type { Corpus } from '../obsidian/corpus/corpus.js';
import { formatRebuild, type CorpusIdentity } from '../obsidian/corpus/identity.js';
import {
  reconcileProfile,
  withReconcileLock,
  type ReconcileDeps,
  type ReconcileSummary,
} from '../obsidian/corpus/reconcile.js';
import { CorpusLockTimeoutError, describeHolder } from '../obsidian/corpus/reconcile-lock.js';
import { ensureCorpusGitignored, isManifestCompatible } from '../obsidian/corpus/shard-store.js';
import type { EmbedDocumentsFn, StoredManifest } from '../obsidian/corpus/types.js';
import type { BackendStatus } from '../obsidian/semantic-backend.js';

/**
 * Backoff for the self-retry after a pass leaves a profile `unavailable` or
 * times out on the lock: the first retry waits this long, each further one
 * doubles it up to {@link RETRY_MAX_MS}. Without it a vault nobody edits has no
 * way back — the watcher is the only other thing that ever asks for a pass.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 900_000;

export interface LoopProfile {
  key: string;
  identity: CorpusIdentity;
  /** `size()` is the empty-corpus guard's measure: the notes that can rank. */
  corpus: Corpus & { load(): Promise<void>; readonly loaded: boolean; size(): number };
  embedDocuments: EmbedDocumentsFn;
  enabled: boolean;
}

export interface LastReconcile {
  at: string;
  added: number;
  changed: number;
  removed: number;
  ms: number;
}

export interface ReconcileLoopDeps {
  vaultRoot: string;
  vaultName: string;
  scan: () => Promise<string[]>;
  stat: ReconcileDeps['stat'];
  readNote: ReconcileDeps['readNote'];
  /** Defaults to console.error — warnings must never touch stdout. */
  warn?: (message: string) => void;
  /** Injected by tests; production uses {@link RETRY_BASE_MS}/{@link RETRY_MAX_MS}. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  now?: () => number;
  /** Injected by tests; production uses withReconcileLock. */
  withLock?: typeof withReconcileLock;
}

export interface ReconcileLoop {
  /** Starts the profile's startup selection; the next pass reconciles it. */
  addProfile(profile: LoopProfile): void;
  /**
   * Leaves the loop; the caller disposes the corpus. The loop disposes it again
   * when it finishes any work on it still in flight, so that corpus object must
   * not be attached again — a later `addProfile` with the same key takes a new one.
   */
  removeProfile(key: string): void;
  status(key: string): BackendStatus;
  lastReconcile(key: string): LastReconcile | undefined;
  /** Coalesces: requests in one synchronous run share a pass, and any during a pass queue one more. */
  requestPass(): void;
  /**
   * Resolves once every pending startup selection and the pass in flight have
   * settled, including any follow-up pass the dirty flag chains behind it — so
   * a test must release whatever it gated before awaiting this. A retry timer
   * that has not fired is not waited for. Tests only.
   */
  whenSettled(): Promise<void>;
  /** Aborts the pass in flight and resolves once it and any startup selection settled. */
  dispose(): Promise<void>;
}

interface ProfileState {
  profile: LoopProfile;
  status: BackendStatus;
  /** The startup selection; a pass awaits it before touching this corpus. Never rejects. */
  selection: Promise<void>;
  last?: LastReconcile;
  removed: boolean;
}

const indexing = (): BackendStatus => ({ state: 'indexing', indexed: 0, total: 0 });

/**
 * One vault's reconcile loop over every attached model profile (design D5):
 * `createCorpusBackend`'s state machine kept per profile, with one pass at a
 * time for the vault. A pass takes the vault's lock once, scans once, and
 * reconciles the profiles enabled when it began, in the order they were added;
 * a profile added later is built by the next pass.
 *
 * Each profile keeps the backend's rules: a compatible corpus with records is
 * `ready` the moment its startup selection loaded it; a pass that throws for a
 * profile makes that profile `unavailable` and moves on to the next; a pass
 * that waited for another holder refreshes each corpus before reconciling it;
 * a lock timeout restores what every profile reported before the pass. Either
 * failure re-arms the loop on a doubling backoff, and a profile retried from
 * `unavailable` reports `indexing` while its pass runs.
 *
 * A disabled profile reports `disabled` and is never loaded or reconciled, and
 * a loop whose profiles are all disabled never takes the lock.
 */
export function createReconcileLoop(deps: ReconcileLoopDeps): ReconcileLoop {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
  const retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const now = deps.now ?? Date.now;
  const withLock = deps.withLock ?? withReconcileLock;

  /** In addition order: the order a pass walks them. */
  const profiles = new Map<string, ProfileState>();
  const selections = new Set<Promise<void>>();
  /** The pass in flight (or about to begin), or null when idle. */
  let currentPass: Promise<void> | null = null;
  /** Whether the current pass has taken its profile list — a request before that is served by it. */
  let passBegun = false;
  /** A request that arrived while a pass was running — one follow-up, however many arrived. */
  let dirty = false;
  let disposed = false;
  /** Aborts the pass in flight, so `dispose()` does not wait out a cold index. */
  let passAbort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = retryBaseMs;
  /** The last pass gave up waiting for another process's lock: not a failure, but re-armed like one. */
  let lockTimedOut = false;

  const label = (key: string) => `vault "${deps.vaultName}" (profile "${key}")`;

  function stateOf(key: string): ProfileState {
    const state = profiles.get(key);
    if (state === undefined) throw new Error(`reconcile loop: unknown profile "${key}"`);
    return state;
  }

  function unavailable(state: ProfileState, reason: string): void {
    state.status = { state: 'unavailable', reason };
    warn(`neuro-vault semantic: corpus unavailable for ${label(state.profile.key)}: ${reason}`);
  }

  // Never silent (design D8), whichever step finds the mismatch.
  function announceRebuild(key: string, stored: StoredManifest | null, active: CorpusIdentity) {
    const named = formatRebuild(stored, active);
    warn(
      `neuro-vault corpus: ${label(key)} was indexed with ${named.stored}; ` +
        `active model is ${named.active} — discarding the corpus and re-indexing in the background`,
    );
  }

  /**
   * A removed profile's corpus is the caller's to dispose, and that may already
   * have happened: whatever this loop just loaded into it must not stay resident.
   */
  function releaseIfRemoved(state: ProfileState): boolean {
    if (state.removed) state.profile.corpus.dispose();
    return state.removed;
  }

  function clearRetry(): void {
    if (retryTimer === undefined) return;
    clearTimer(retryTimer);
    retryTimer = undefined;
  }

  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);
    retryTimer = setTimer(() => {
      retryTimer = undefined;
      requestPass();
    }, delay);
    // A pending retry must never be the reason the process stays alive (design D10).
    (retryTimer as { unref?: () => void }).unref?.();
  }

  /**
   * The startup selection: a compatible corpus with records is served as soon
   * as it is in memory. Failures are reported, not thrown — the pass that
   * follows loads whatever is not loaded.
   */
  async function select(state: ProfileState): Promise<void> {
    const { corpus, identity } = state.profile;
    try {
      const stored = await corpus.identity();
      // Checked before the load, so records are assumed: vectors of another
      // identity (or of none on record) rank against nothing, and the pass that
      // discards them announces it.
      if (!isManifestCompatible(stored, identity, true)) return;
      await corpus.load();
      if (releaseIfRemoved(state) || disposed) return;
      if ((await corpus.entries()).size > 0) state.status = { state: 'ready' };
    } catch (err) {
      if (!state.removed && !disposed) unavailable(state, String(err));
    }
  }

  async function reconcileOne(
    state: ProfileState,
    paths: string[],
    waited: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { key, corpus, identity, embedDocuments } = state.profile;
    if (state.status.state === 'unavailable') state.status = indexing();
    const started = now();
    // Another holder may have changed the shards — a note it re-embedded is
    // `reused` by this pass, so memory would otherwise keep the old vectors.
    if (waited && corpus.loaded) await corpus.refresh();
    // Cold, incompatible, or a failed startup load: reconcile reads `entries()`,
    // which needs memory, so settle the identity first and load what survives.
    if (!corpus.loaded) {
      const { rebuilt, previous } = await corpus.ensureIdentity(identity);
      if (rebuilt) announceRebuild(key, previous, identity);
      if (!corpus.loaded) await corpus.load();
    }
    const summary = await reconcileProfile(
      {
        vaultRoot: deps.vaultRoot,
        stat: deps.stat,
        readNote: deps.readNote,
        embedDocuments,
        identity,
        // Per-note warnings name the vault root only; with several profiles they
        // must say whose corpus failed, as the guard's reason points at them.
        warn: (message) => warn(`[profile "${key}"] ${message}`),
      },
      corpus,
      paths,
      {
        signal,
        onRebuild: ({ stored, active }) => announceRebuild(key, stored, active),
        onProgress: (progress) => {
          // Counters are only meaningful while the corpus is still being built.
          if (state.status.state !== 'indexing') return;
          state.status = { state: 'indexing', indexed: progress.indexed, total: progress.total };
        },
      },
    );
    // An aborted run is a shutdown, not a result: its summary is partial.
    if (signal.aborted || releaseIfRemoved(state)) return;
    const finished = now();
    state.last = lastOf(summary, finished, finished - started);
    // A pass that returns is not a pass that worked. `reconcileProfile` is
    // per-note tolerant by design: a rejected `embed` — an offline first run,
    // an unwritable model cache, an ONNX load failure — is counted in
    // `summary.failed` and the run returns normally. When every note went that
    // way the corpus holds nothing that can rank, so `ready` would report a
    // broken index as a healthy empty one.
    //
    // All three clauses are load-bearing, and none alone is the guard:
    // `size() === 0` also describes an empty vault (`total > 0` rules that out)
    // and a healthy vault whose notes are all below the size gate, which index
    // fine and carry no vector (`failed > 0` rules that out — nothing failed
    // there); `failed > 0` alone also describes a healthy incremental pass that
    // lost one note, whose corpus is not empty, because a failed note keeps the
    // record it already had.
    //
    // Deliberately NOT also requiring `embedded === 0`: a note under `MIN_CHARS`
    // gets no note vector and no qualifying block, so `embedNote` calls `embed`
    // zero times, writes a record that carries no embedding, and still counts
    // as `embedded`. One stub note in a cold vault would therefore keep the
    // guard silent while every real note failed. `size()` is read from memory
    // on every pass, so the reused stub cannot latch `ready` either; a later
    // pass that embeds anything replaces this state with `ready`.
    if (corpus.size() === 0 && summary.total > 0 && summary.failed > 0) {
      unavailable(
        state,
        `indexing produced no usable corpus: ${summary.failed} of ${summary.total} notes failed and the decoded corpus is empty (see the per-note warnings above)`,
      );
      return;
    }
    state.status = { state: 'ready' };
  }

  async function runPass(): Promise<void> {
    passBegun = true;
    lockTimedOut = false;
    // A dispose() between the request and this microtask has nothing to abort yet.
    if (disposed) return;
    const members = [...profiles.values()].filter((state) => state.profile.enabled);
    if (members.length === 0) return;
    // A pass that follows a failure IS a build in flight, so say so — else the
    // profile reports `unavailable` across its rebuild and callers start a
    // competing `index`. `ready` is left alone: a reconcile behind a serving
    // corpus must not take it off the air. A lock timeout restores what this replaced.
    const replaced = new Map<ProfileState, { before: BackendStatus; set: BackendStatus }>();
    for (const state of members) {
      if (state.status.state !== 'unavailable') continue;
      const set = indexing();
      replaced.set(state, { before: state.status, set });
      state.status = set;
    }
    const abort = new AbortController();
    passAbort = abort;
    const { signal } = abort;
    const settled = new Set<ProfileState>();
    try {
      await withLock(deps.vaultRoot, { signal, warn }, async ({ waited }) => {
        const paths = await deps.scan();
        for (const state of members) {
          if (signal.aborted) break;
          await state.selection;
          if (state.removed || signal.aborted) continue;
          try {
            await reconcileOne(state, paths, waited, signal);
          } catch (err) {
            if (!releaseIfRemoved(state) && !signal.aborted) unavailable(state, String(err));
          }
          settled.add(state);
        }
        // Corpus maintenance, skipped on abort so a shutdown is bounded by the note in flight.
        if (!signal.aborted) await ensureCorpusGitignored(deps.vaultRoot, { warn });
      });
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof CorpusLockTimeoutError) {
        // Someone is still building; this vault is not broken. Reporting
        // `unavailable` would take serving profiles off the air and tell callers
        // to run a competing `index` (design D7).
        lockTimedOut = true;
        for (const [state, { before, set }] of replaced) {
          if (state.status === set) state.status = before;
        }
        warn(
          `neuro-vault corpus: vault "${deps.vaultName}": ${err.lockFile} is still held by ` +
            `${describeHolder(err.holderPid, err.holderHost)} — ` +
            `serving the current corpus and retrying later`,
        );
        return;
      }
      // Outside every profile's own step (the scan, the migration): each profile
      // this pass had not finished fails with it.
      for (const state of members) {
        if (!state.removed && !settled.has(state)) unavailable(state, String(err));
      }
    } finally {
      passAbort = null;
    }
  }

  function requestPass(): void {
    if (disposed) return;
    // Whoever asked supersedes the pending self-retry — the pass about to run
    // (or the one already running) is the retry.
    clearRetry();
    if (currentPass) {
      if (passBegun) dirty = true;
      return;
    }
    passBegun = false;
    // Begun on a microtask, so an attach adding several profiles is one pass.
    currentPass = Promise.resolve()
      .then(runPass)
      .finally(() => {
        currentPass = null;
        if (dirty) {
          dirty = false;
          requestPass();
          return;
        }
        const failed = [...profiles.values()].some((s) => s.status.state === 'unavailable');
        if (failed || lockTimedOut) scheduleRetry();
        else retryDelay = retryBaseMs;
      });
  }

  return {
    addProfile(profile) {
      if (disposed) throw new Error('reconcile loop: disposed');
      if (profiles.has(profile.key)) {
        throw new Error(`reconcile loop: profile "${profile.key}" is already attached`);
      }
      const state: ProfileState = {
        profile,
        status: profile.enabled ? indexing() : { state: 'disabled' },
        selection: Promise.resolve(),
        removed: false,
      };
      profiles.set(profile.key, state);
      if (!profile.enabled) return;
      const selection = select(state).finally(() => selections.delete(selection));
      selections.add(selection);
      state.selection = selection;
      requestPass();
    },
    removeProfile(key) {
      const state = stateOf(key);
      state.removed = true;
      profiles.delete(key);
    },
    status: (key) => stateOf(key).status,
    lastReconcile: (key) => stateOf(key).last,
    requestPass,
    async whenSettled() {
      for (;;) {
        await Promise.all(selections);
        if (currentPass === null) return;
        await currentPass;
      }
    },
    async dispose() {
      disposed = true;
      clearRetry();
      // Not just a flag: a cold index is thousands of reads and embeds, each an
      // active libuv request holding the event loop open (design D10).
      passAbort?.abort();
      await Promise.all([currentPass, ...selections]);
    },
  };
}

function lastOf(summary: ReconcileSummary, at: number, ms: number): LastReconcile {
  return {
    at: new Date(at).toISOString(),
    added: summary.added,
    changed: summary.embedded - summary.added + summary.renamed,
    removed: summary.deleted,
    ms,
  };
}
