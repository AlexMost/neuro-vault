import type { ReconcileOptions, ReconcileSummary } from '../../../lib/obsidian/corpus/reconcile.js';
import {
  isManifestCompatible,
  type CorpusStore,
} from '../../../lib/obsidian/corpus/shard-store.js';
import {
  EMBED_VERSION,
  MODEL_DIMS,
  MODEL_ID,
  MODEL_KEY,
  SC_PARITY_STRATEGY,
  type CorpusShard,
} from '../../../lib/obsidian/corpus/types.js';
import { buildBasenameIndex } from '../../../lib/obsidian/link-resolver.js';
import type {
  BackendStatus,
  CorpusSnapshot,
  SemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';

/** The corpus identity this build produces — what a stored manifest must match. */
const EXPECTED_IDENTITY = {
  embed_version: EMBED_VERSION,
  model_key: MODEL_KEY,
  model_id: MODEL_ID,
  dims: MODEL_DIMS,
  strategy: SC_PARITY_STRATEGY,
};

/**
 * Backoff for the self-retry after a pass leaves the vault `unavailable`: the
 * first retry waits this long, each further failure doubles it up to
 * {@link RETRY_MAX_MS}. Without it a vault nobody edits has no way back — the
 * watcher is the only other thing that ever asks for a pass.
 */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 900_000;

export interface CorpusBackendDeps {
  vaultRoot: string;
  vaultName: string;
  /** Global `--semantic` AND the per-vault config, already resolved. */
  enabled: boolean;
  store: CorpusStore;
  /**
   * Shard → snapshot decode, already bound to this vault's scope. Production:
   * `loadCorpusSnapshot`. `shards`, when given, is a listing the caller has
   * already read — passing it is what keeps the startup selection from reading
   * and parsing the whole corpus twice.
   */
  loadSnapshot: (
    store: CorpusStore,
    opts?: { shards?: Map<string, CorpusShard> },
  ) => Promise<CorpusSnapshot>;
  /**
   * Pre-bound per vault — this backend never assembles scan/stat/read/embed
   * itself. Production: `reconcileCorpus` closed over the vault's deps.
   */
  reconcile: (opts: ReconcileOptions) => Promise<ReconcileSummary>;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
  /** Injected by tests; production uses {@link RETRY_BASE_MS}/{@link RETRY_MAX_MS}. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface CorpusBackend extends SemanticBackend {
  /** Resolves when the current background pass settles. Tests only. */
  whenSettled(): Promise<void>;
  /** Requests another reconcile; coalesces while one is running. */
  requestReconcile(): void;
}

function emptySnapshot(): CorpusSnapshot {
  return { sources: new Map(), basenameIndex: buildBasenameIndex([]) };
}

/**
 * One vault's corpus lifecycle: the four states, and the background pass that
 * moves between them (design D3).
 *
 * Startup never blocks — the constructor returns immediately and the selection
 * plus the first reconcile run on their own. A compatible corpus is served the
 * moment it is decoded, even while a catch-up pass runs behind it; an
 * incompatible or absent one reports `indexing` until the pass that builds it
 * finishes. Promotion is atomic by construction (design D2): the decoded
 * snapshot lives in memory, `snapshot()` never touches disk, and a rebuild
 * replaces the old object in a single assignment, so a caller already holding a
 * reference keeps ranking against a coherent snapshot.
 *
 * A pass that throws reports `unavailable` with the reason and keeps whatever
 * snapshot the vault already had — as does a pass that returns normally having
 * failed every note it tried, which leaves nothing to serve. That is not
 * terminal: the backend re-arms itself on a doubling backoff
 * ({@link RETRY_BASE_MS}..{@link RETRY_MAX_MS}) and reports `indexing` again
 * while the retry runs, so a vault that recovers reports `ready` again without
 * a restart — and without needing someone to edit a note first, which the
 * watcher-only wiring used to require.
 *
 * `enabled === false` is absolute: the vault reports `disabled` and no pass ever
 * runs, so nothing is read from or written under `.neuro-vault/corpus/`.
 */
export function createCorpusBackend(deps: CorpusBackendDeps): CorpusBackend {
  const warn = deps.warn ?? ((message: string) => console.error(message));
  const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
  const retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let snapshot: CorpusSnapshot = emptySnapshot();
  /**
   * Whether `snapshot` was ever decoded from the corpus, as opposed to being
   * the empty placeholder the vault starts with. `ready` must never be reported
   * over the placeholder.
   */
  let snapshotLoaded = false;
  let status: BackendStatus = deps.enabled
    ? { state: 'indexing', indexed: 0, total: 0 }
    : { state: 'disabled' };
  /** The pass in flight, or null when idle. */
  let currentPass: Promise<void> | null = null;
  /** Whether any pass has begun — the startup selection defers to one that has. */
  let passStarted = false;
  /** A request that arrived while a pass was running — one follow-up, however many arrived. */
  let dirty = false;
  let disposed = false;
  /** Aborts the reconcile in flight, so `dispose()` does not wait out a cold index. */
  let passAbort: AbortController | null = null;
  /** The pending self-retry after a failed pass, and its current backoff. */
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = retryBaseMs;

  function clearRetry(): void {
    if (retryTimer === undefined) return;
    clearTimer(retryTimer);
    retryTimer = undefined;
  }

  /**
   * Re-arms the vault after a pass left it `unavailable`. The watcher is the
   * only other thing that ever calls `kick()`, so a vault nobody edits — a
   * read-only reference vault, or one whose watcher failed to start — would
   * otherwise stay broken until the process restarts, even once the cause (an
   * absent model, a full disk, a lost network) has cleared.
   */
  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, retryMaxMs);
    retryTimer = setTimer(() => {
      retryTimer = undefined;
      kick();
    }, delay);
    // A pending retry must never be the reason the process stays alive: nobody
    // is waiting on it, and a client that hung up should still exit (design D10).
    (retryTimer as { unref?: () => void }).unref?.();
  }

  function unavailable(reason: string): void {
    status = { state: 'unavailable', reason };
    warn(`neuro-vault semantic: corpus unavailable for vault "${deps.vaultName}": ${reason}`);
  }

  function fail(err: unknown): void {
    unavailable(String(err));
  }

  async function runPass(): Promise<void> {
    // A pass that follows a failure IS a build in flight, so say so. Without
    // this the vault would keep reporting `unavailable` for the whole rebuild —
    // no counters, and `get_similar_notes` telling the caller to run a second,
    // competing `neuro-vault-mcp index` against the corpus this pass is
    // already writing. `ready` is deliberately left alone: a reconcile behind a
    // corpus that is already serving must not take it off the air.
    if (status.state === 'unavailable') {
      status = { state: 'indexing', indexed: 0, total: 0 };
    }
    const abort = new AbortController();
    passAbort = abort;
    try {
      const summary = await deps.reconcile({
        signal: abort.signal,
        onProgress: (progress) => {
          // Counters are only meaningful while the corpus is still being built.
          if (status.state !== 'indexing') return;
          status = { state: 'indexing', indexed: progress.indexed, total: progress.total };
        },
      });
      // An aborted pass is a shutdown, not a result: its summary is partial, so
      // decoding or promoting anything from it would be reporting half a run.
      if (disposed) return;
      // Reload when the corpus moved — and whenever nothing has ever been
      // decoded, or a vault whose startup load failed or was abandoned would
      // report `ready` over the empty placeholder, with the very pass that
      // should repair it declining because it changed nothing.
      if (!snapshotLoaded || summary.embedded + summary.renamed + summary.deleted > 0) {
        const loaded = await deps.loadSnapshot(deps.store);
        // A pass that returns is not a pass that worked. `reconcileCorpus` is
        // per-note tolerant by design: a rejected `embed` — an offline first
        // run, an unwritable model cache, an ONNX load failure — is counted in
        // `summary.failed` and the pass returns normally. When every note went
        // that way there is no shard to decode, so serving the empty result
        // behind `ready` would report a broken index as a healthy empty one.
        //
        // All three clauses are load-bearing, and none alone is the guard:
        // `sources.size === 0` also describes an empty vault (`total > 0`
        // rules that out) and a healthy vault whose notes are all below the
        // size gate, which index fine and contribute no source (`failed > 0`
        // rules that out — nothing failed there); `failed > 0` alone also
        // describes a healthy incremental pass that lost one note, whose
        // decoded corpus is not empty, because a failed note keeps the shard
        // it already had.
        //
        // Deliberately NOT also requiring `embedded === 0`: a note under
        // `MIN_CHARS` gets no note vector and no qualifying block, so
        // `embedNote` calls `embed` zero times, writes a shard that carries no
        // embedding, and still counts as `embedded`. One stub note in a cold
        // vault would therefore have kept this guard silent while every real
        // note failed — and, because the stub is `reused` from then on, the
        // load branch would never run again and the vault would sit at `ready`
        // over an empty corpus until something in it changed.
        if (loaded.sources.size === 0 && summary.total > 0 && summary.failed > 0) {
          // `snapshot`/`snapshotLoaded` are left untouched: the vault keeps
          // whatever it had, and the next pass reloads unconditionally rather
          // than trusting a decode that produced nothing. Not terminal — a
          // later pass that embeds anything overwrites this state with `ready`.
          unavailable(
            `indexing produced no usable corpus: ${summary.failed} of ${summary.total} notes failed and the decoded corpus is empty (see the per-note warnings above)`,
          );
          return;
        }
        snapshot = loaded;
        snapshotLoaded = true;
      }
      status = { state: 'ready' };
    } catch (err) {
      fail(err);
    } finally {
      passAbort = null;
    }
  }

  function kick(): void {
    // A vault that opted out runs nothing, whoever asks — not at startup, and
    // not for a `requestReconcile()` a watcher fans out across every vault.
    if (!deps.enabled || disposed) return;
    // Whoever asked supersedes the pending self-retry — the pass about to run
    // (or the one already running) is the retry.
    clearRetry();
    if (currentPass) {
      dirty = true;
      return;
    }
    passStarted = true;
    currentPass = runPass().finally(() => {
      currentPass = null;
      if (dirty) {
        dirty = false;
        kick();
        return;
      }
      // A pass that ended `unavailable` re-arms itself; any other outcome means
      // the vault recovered, so the backoff starts over.
      if (status.state === 'unavailable') scheduleRetry();
      else retryDelay = retryBaseMs;
    });
  }

  /**
   * The startup selection (design D3), as data: the snapshot to serve, or null
   * when there is nothing compatible on disk to serve yet.
   */
  async function selectStartupSnapshot(): Promise<CorpusSnapshot | null> {
    const [manifest, shards] = await Promise.all([
      deps.store.readManifest(),
      deps.store.listShards(),
    ]);
    const hasShards = shards.size > 0;
    if (!hasShards || !isManifestCompatible(manifest, EXPECTED_IDENTITY, hasShards)) return null;
    // Hand the listing on rather than letting the decode re-read it: `shards`
    // already holds every shard file, parsed. Re-listing here would read and
    // `JSON.parse` the whole corpus a second time on every startup.
    return deps.loadSnapshot(deps.store, { shards });
  }

  /**
   * Applies the startup selection, then hands over to the background pass. Any
   * failure here is reported, not thrown: an unreadable or corrupt corpus is
   * something the pass that follows repairs, because `runPass` forces a load
   * whenever no snapshot has ever been decoded.
   */
  async function initialize(): Promise<void> {
    try {
      const selected = await selectStartupSnapshot();
      // A `requestReconcile()` arriving before the selection settles starts a
      // pass beside it. That pass reconciles the corpus and decodes the result
      // itself, so its snapshot is the fresher one — abandon the selection
      // rather than race it, or stale content would be served behind `ready`
      // until the next real vault change.
      if (selected !== null && !passStarted) {
        snapshot = selected;
        snapshotLoaded = true;
        status = { state: 'ready' };
      }
    } catch (err) {
      fail(err);
    } finally {
      kick();
    }
  }

  const startup: Promise<void> = deps.enabled ? initialize() : Promise.resolve();

  return {
    snapshot: () => Promise.resolve(snapshot),
    status: () => status,
    dispose: () => {
      disposed = true;
      clearRetry();
      // Not just a flag: a cold index is thousands of reads and embeds, and
      // every one of them is an active libuv request holding the event loop
      // open. Flagging alone would leave the process running out the whole
      // index after the client that started it hung up (design D10).
      passAbort?.abort();
      passAbort = null;
      return Promise.resolve();
    },
    whenSettled: async () => {
      // The pass in flight when the call was made — never a follow-up chained
      // behind it, which may itself be waiting on work the caller has not
      // released yet.
      const inFlight = currentPass;
      if (inFlight) {
        await inFlight;
        return;
      }
      await startup;
      if (currentPass) await currentPass;
    },
    requestReconcile: kick,
  };
}
