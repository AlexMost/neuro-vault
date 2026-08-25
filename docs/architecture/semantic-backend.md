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

`unavailable` is not terminal. It is not a decision frozen at startup the way the corpus that preceded this design (`semanticAvailable: false`, decided once and never revisited) used to be — the next pass, whether from the watcher or an explicit request, re-runs the same reconcile and promotes back to `ready` on success.

## Live promotion

`snapshot()` never touches disk — it returns whatever `CorpusSnapshot` is currently held in memory. A background pass replaces that value in a single assignment only when it changed something (`embedded + renamed + deleted > 0` from the reconcile summary) or when nothing has ever been decoded yet (so a vault that started `indexing` or recovered from `unavailable` does not get stuck serving the empty placeholder). A caller already holding a reference from an in-flight call keeps ranking against a coherent snapshot; the next call sees the promoted one.

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
- **`get_similar_notes`** and **`find_duplicates`** have no non-semantic leg, so they fail structurally instead. Both resolve their vault through `resolveSemanticVault` (`src/lib/resolve-vault.ts`), which maps `status()` to one of three `ToolHandlerError` codes:

  | `status().state` | Error code | `details` |
  | --- | --- | --- |
  | `indexing` | `SEMANTIC_INDEX_BUILDING` | `{ vault, indexed, total }` |
  | `disabled` | `SEMANTIC_DISABLED` | `{ vault, hint }` naming the config key |
  | `unavailable`, or `entry.backend` absent | `SEMANTIC_INDEX_NOT_FOUND` | `{ vault, hint }` naming `neuro-vault-mcp index --vault <path>` |
  | `ready` | — call proceeds | — |

  An absent backend (semantic module off server-wide) is folded into the same `unavailable` branch with a fixed reason, rather than a fourth code — from a caller's point of view "no backend" and "a backend that never became usable" need the same response.

## Disposal

A live `chokidar` watcher holds the Node event loop open, so it is a resource the server must release explicitly rather than let the process exit around. `createOwnCorpusBackendFactory` (`src/modules/semantic/backend/index.ts`) composes each vault's `dispose()` to close the watcher first, then the underlying corpus backend, `finally`-chained so a rejecting `watcher.close()` still lets the backend dispose. `startNeuroVaultServer` (`src/server.ts`) chains onto the MCP SDK's own `transport.onclose` — never replacing it — and calls every vault entry's `backend?.dispose()` via `Promise.allSettled`, so one vault's disposal failure is reported to stderr without blocking the others. This is what lets the stdio process exit when its client disconnects instead of hanging on an open watcher.

## Boundaries

This page is about the runtime lifecycle only. Extraction, the shard/manifest on-disk format, and the reconcile algorithm itself belong to [`own-corpus.md`](./own-corpus.md). Ranking, fusion, and the quick/deep retrieval modes belong to [`retrieval-policy.md`](./retrieval-policy.md) and [`rank-fusion.md`](./rank-fusion.md) — this backend hands them a `CorpusSnapshot` and nothing more.
