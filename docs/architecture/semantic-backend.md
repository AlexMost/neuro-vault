# The Semantic Backend

The per-vault seam every semantic tool ranks and reports through: the `SemanticBackend` contract, the four states a vault's index can be in, the startup and freshness machinery that moves between them, and the process-wide embed queue that machinery shares with live search. The decisions behind this are [ADR-0013](../adr/0013-own-embedding-corpus.md) (the server owns a corpus) and [ADR-0014](../adr/0014-background-corpus-freshness.md) (it stays fresh in the background). The corpus mechanism itself — extraction, shard layout, atomic writes, reconcile — is documented in [`own-corpus.md`](./own-corpus.md); this page is about the runtime lifecycle wrapped around it.

## The contract

`src/lib/obsidian/semantic-backend.ts` defines what every semantic tool depends on and nothing more:

```typescript
interface CorpusSnapshot {
  sources: Map<string, SmartSource>;
  basenameIndex: BasenameIndex;
}

type BackendState = 'ready' | 'indexing' | 'disabled' | 'unavailable';

interface BackendStatus {
  state: BackendState;
  indexed?: number; // present only while state === 'indexing'
  total?: number; // present only while state === 'indexing'
  reason?: string; // present only for state === 'unavailable'
}

interface SemanticBackend {
  snapshot(): Promise<CorpusSnapshot>;
  status(): BackendStatus;
  dispose(): Promise<void>;
}
```

`IVaultEntry.backend?: SemanticBackend` ([`vault-registry.md`](./vault-registry.md)) carries one of these per vault. It is absent only when the semantic module is globally off (`--no-semantic`) — no semantic tool is registered in that case, so nothing reads it. A per-vault `"semantic": false` in `.neuro-vault/config.json` still gets a backend; that backend is simply built `enabled: false` and permanently reports `disabled`.

`disabled` and `unavailable` mean different things and must never be confused: `disabled` is a deliberate choice (the vault turned semantics off); `unavailable` is broken (a reconcile failed, or there is nothing usable yet and never has been). `src/modules/semantic/backend/corpus-backend.ts` never reports a failure as `disabled`.

## Startup: serve what you can, then catch up

`createCorpusBackend` (`src/modules/semantic/backend/corpus-backend.ts`) decides a vault's starting state without blocking construction — `VaultRegistry.create` never awaits a backend, so server startup is not gated on any vault's index:

| Condition | Outcome |
| --- | --- |
| `enabled: false` (module off or vault opted out) | `disabled`. No reconcile ever runs; nothing is read from or written under `.neuro-vault/corpus/`. |
| Stored manifest is compatible with the running model/strategy identity, and shards exist | Snapshot decoded immediately, state `ready`; a reconcile still runs in the background to catch up on anything since the last write. |
| No compatible manifest, or no shards | State `indexing`; a reconcile builds the corpus from scratch, promoting to `ready` when it finishes. |
| A reconcile pass throws | State `unavailable`, with `reason` set from the error. The vault keeps whatever snapshot it already had — an empty one if it never had any. |
| A reconcile pass returns, having left nothing rankable to serve | State `unavailable`, with a `reason` naming the counts. `reconcileCorpus` is per-note tolerant — a rejected `embed` is counted in `summary.failed` and the pass returns normally — so a cold vault with no reachable embedding model would otherwise be promoted to `ready` over an empty corpus. The guard is exactly three clauses: the decoded snapshot is empty _and_ `total > 0` _and_ `failed > 0`. An empty vault has no `total`; a healthy vault whose notes are all below the size gate has no `failed`; a healthy incremental pass that lost one note has a non-empty snapshot, because a failed note keeps the shard it already had. Note the guard deliberately does _not_ require `embedded === 0`: a below-gate note calls `embed` zero times and still counts as `embedded`, so one stub note would otherwise mask a wholly failed pass — durably, since the stub is `reused` from the next pass on. |

`unavailable` is not terminal. It is not a decision frozen at startup the way the corpus that preceded this design (`semanticAvailable: false`, decided once and never revisited) used to be — the next pass, whether from the watcher or an explicit request, re-runs the same reconcile and promotes back to `ready` on success.

That recovery does not depend on anyone touching the vault. A pass that ends `unavailable` re-arms itself on a doubling backoff (`RETRY_BASE_MS` 30 s to `RETRY_MAX_MS` 15 min, `corpus-backend.ts`), reset on the first pass that does not fail; a watcher event or an explicit request supersedes the pending retry, since that pass _is_ the retry. Without it the watcher would be the only path back, and a vault nobody edits — a read-only reference vault, or one whose watcher failed to start — would stay broken until the process restarted, long after the cause (an absent model, a full disk, a lost network) had cleared. The retry timer is `unref`'d, so it never keeps the process alive on its own.

A retry pass reports `indexing`, with counters, for its duration: a rebuild in flight is a build in flight, and reporting `unavailable` across it would tell a caller to run a second, competing `neuro-vault-mcp index` against the corpus that pass is already writing. A reconcile behind a corpus that is already `ready` is the one case that does _not_ change state — that vault is still serving.

## Live promotion

`snapshot()` never touches disk — it returns whatever `CorpusSnapshot` is currently held in memory. A background pass replaces that value in a single assignment only when it changed something (`embedded + renamed + deleted > 0` from the reconcile summary) or when nothing has ever been decoded yet (so a vault that started `indexing` or recovered from `unavailable` does not get stuck serving the empty placeholder). A caller already holding a reference from an in-flight call keeps ranking against a coherent snapshot; the next call sees the promoted one.

Every decode applies the vault's scope (`VaultScope.isExcluded`), so `sources` and `basenameIndex` never name an excluded note. The corpus on disk only agrees with the scope after a reconcile has swept the out-of-scope shards as orphans, which leaves two windows where it does not: between a `.gitignore`/`config.json` change and the pass that acts on it — including the warm snapshot served at startup, decoded before any pass runs — and after a shard deletion that failed. Neither is covered by `filterExisting`, which tests existence on disk, not membership. Filtering at decode closes both, and keeps the semantic leg from surfacing what the lexical leg (reading through the scoped reader) already hides.

## Freshness: the watcher and the debounce

Each enabled backend gets one `chokidar` watcher over its vault root (`src/modules/semantic/backend/vault-watcher.ts`), `.md` files only, every dot-path ignored so the server's own corpus writes cannot feed the watcher back into itself. Any add/change/unlink event resets a debounce timer; `DEBOUNCE_MS` (10,000 ms, `vault-watcher.ts`) after the last event, `onQuiet` fires and calls `backend.requestReconcile()`.

`requestReconcile()` on the corpus backend coalesces: a request that arrives while a pass is already running just sets a flag, and exactly one follow-up pass runs when the current one finishes — however many requests arrived in between. This is the same `reconcileCorpus` pass startup runs; there is one definition of "changed" in the system, not two.

A watcher that fails to start, or errors once running, degrades rather than fails: it logs to stderr and returns a no-op handle (start failure) or simply keeps running past the error (runtime failure) — either way the vault falls back to reconcile-on-start, and the server keeps serving every vault, including the degraded one, on whatever corpus it already has. See [ADR-0014](../adr/0014-background-corpus-freshness.md) for the rationale and the dependency it costs.

## The shared embed queue

One `QueuedEmbedder` (`src/modules/semantic/embed-queue.ts`) wraps the single process-wide `EmbeddingService` instance in a FIFO queue with two lanes:

- `embedQuery` enqueues on the **query lane** — the retrieval path (`asProvider()`, wired into `search_notes`/`get_similar_notes`/`find_duplicates`) uses this.
- `embedIndex` enqueues on the **index lane** — reconcile (`asIndexEmbedFn()`, wired into every backend's `reconcile` dependency) uses this.

The pump always drains the query lane first. A query issued while a vault is cold-indexing therefore waits for at most the one embed already in flight (~25 ms), never behind the thousands of queued indexing embeds — one model instance serves every vault's indexing and every live query without either starving the other.

## Who reads the state

Three tools, two different postures:

- **`search_notes`** never fails on backend state. It reads `status()` once per call into a `semantic_status: { state, indexed?, total? }` field that rides on every response, in every mode, including `mode: "lexical"` and the empty-filter early return — the field describes the vault's index, not whether this particular request touched it. Anything other than `ready` (`indexing`, `disabled`, `unavailable`, or an absent backend) makes the call degrade to its lexical leg rather than error.

  Degradation also covers the leg failing on a backend that _reported_ `ready` — a rejected query embedding (no model on disk, an unwritable cache, an ONNX load failure) or an unreadable snapshot. The lexical matches are already computed by then, so the call returns them instead of discarding them for a `DEPENDENCY_ERROR`, writes the cause to stderr, and reports `semantic_status: { state: "unavailable" }`: the payload has to describe the response the client is holding, and a lexical-only result labelled `ready` would contradict itself. A failure _outside_ the semantic leg (the wikilink graph, the filter set) still errors as before.
- **`get_similar_notes`** and **`find_duplicates`** have no non-semantic leg, so they fail structurally instead. Both resolve their vault through `resolveSemanticVault` (`src/lib/resolve-vault.ts`), which maps `status()` to one of three `ToolHandlerError` codes:

  | `status().state` | Error code | `details` |
  | --- | --- | --- |
  | `indexing` | `SEMANTIC_INDEX_BUILDING` | `{ vault, indexed, total }` |
  | `disabled` | `SEMANTIC_DISABLED` | `{ vault, hint }` naming the config key |
  | `unavailable`, or `entry.backend` absent | `SEMANTIC_INDEX_NOT_FOUND` | `{ vault, reason, hint }` — the backend's reason, and a hint naming `neuro-vault-mcp index --vault <path>` |
  | `ready` | — call proceeds | — |

  An absent backend (semantic module off server-wide) is folded into the same `unavailable` branch with a fixed reason, rather than a fourth code — from a caller's point of view "no backend" and "a backend that never became usable" need the same response.

## Disposal

A live `chokidar` watcher holds the Node event loop open, so it is a resource the server must release explicitly rather than let the process exit around. `createOwnCorpusBackendFactory` (`src/modules/semantic/backend/index.ts`) composes each vault's `dispose()` to close the watcher first, then the underlying corpus backend, `finally`-chained so a rejecting `watcher.close()` still lets the backend dispose. `startNeuroVaultServer` (`src/server.ts`) chains onto the MCP SDK's own `transport.onclose` — never replacing it — and calls every vault entry's `backend?.dispose()` via `Promise.allSettled`, so one vault's disposal failure is reported to stderr without blocking the others. This is what lets the stdio process exit when its client disconnects instead of hanging on an open watcher.

Closing the watcher is not enough on its own while a vault is indexing. A cold pass is thousands of reads and embeds, each an active libuv request, so `dispose()` also aborts the reconcile in flight: it passes an `AbortSignal` into `reconcileCorpus`, which checks it at each note boundary and returns a partial summary, skipping the orphan sweep and the gitignore write. The caller that aborted discards that summary — a disposed backend promotes nothing. Shutdown is therefore bounded by the single note in flight rather than by the rest of the index.

## Boundaries

This page is about the runtime lifecycle only. Extraction, the shard/manifest on-disk format, and the reconcile algorithm itself belong to [`own-corpus.md`](./own-corpus.md). Ranking, fusion, and the quick/deep retrieval modes belong to [`retrieval-policy.md`](./retrieval-policy.md) and [`rank-fusion.md`](./rank-fusion.md) — this backend hands them a `CorpusSnapshot` and nothing more.
