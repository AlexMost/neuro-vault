# The Semantic Backend

The per-vault seam a session's semantic tools read through: the `ISemanticBackend` contract, its three implementations (the daemon facade, the in-process fallback, and the backend of a vault that opted out), how a vault's status is read and mapped to tool behaviour, the background attach at startup, the embed queue, and teardown. The corpus behind it, with its startup selection, per-note writes, freshness and retries, belongs to the vault entry, documented in [`vault-entry.md`](./vault-entry.md). The session holds no vector, no watcher and no reconcile loop of its own, except when it runs the vault entry itself as the fallback. The decisions are [ADR-0013](../adr/0013-own-embedding-corpus.md) (the server owns a corpus), [ADR-0019](../adr/0019-embedding-storage-interface.md) (sessions read the corpus, never its vectors) and [ADR-0020](../adr/0020-per-vault-state-in-the-daemon.md) (per-vault state lives in the daemon's vault entry).

## The contract

`src/lib/obsidian/semantic-backend.ts` defines what every semantic tool depends on, over the corpus reads of `src/lib/obsidian/corpus/corpus.ts` ([`own-corpus.md`](./own-corpus.md#the-corpus-interface)):

```typescript
type BackendState = 'ready' | 'indexing' | 'disabled' | 'unavailable';

interface BackendStatus {
  state: BackendState;
  indexed?: number; // present only while state === 'indexing'; 0/0 until the scan lands
  total?: number; // present only while state === 'indexing'
  reason?: string; // present for state === 'unavailable'
}

interface ICorpusReader {
  // One list per anchor, in order; null for a path anchor whose note has no vector.
  nearest(anchors: CorpusAnchor[], opts: INearestOptions): Promise<(INoteHit[] | null)[]>;
  nearestBlocks(anchors: CorpusAnchor[], opts: INearestBlocksOptions): Promise<(IBlockHit[] | null)[]>;
}

interface ISemanticBackend extends ICorpusReader {
  status(): Promise<BackendStatus>; // never rejects: an unreadable status is `unavailable` with the reason
  dispose(): Promise<void>;
}

class CorpusNotReadyError extends Error {
  readonly status: BackendStatus; // a read the corpus refused because it is not `ready`
}
```

A read answers paths and similarities (and, for a block, its heading and lines), never a vector. An anchor is a query vector or a note path whose own vector the corpus uses, so a note vector never reaches the session.

`IRegisteredVault.backend?: ISemanticBackend` ([`vault-registry.md`](./vault-registry.md)) carries one per vault. It is absent only when the semantic module is globally off (`--no-semantic`): `get_similar_notes` and `find_duplicates` are not registered then, and `search_notes` (registered with the lexical leg only) reads the absent backend as `disabled`. A vault whose `.neuro-vault/config.json` sets `"semantic": false` still gets a backend, the disabled one below.

`disabled` and `unavailable` mean different things and must never be confused: `disabled` is a deliberate choice (the vault turned semantics off); `unavailable` is broken (a pass failed, nothing usable was ever built, the vault directory is gone, or the status could not be read). No backend and no vault entry reports a failure as `disabled`.

## Three implementations, one factory

`createSemanticBackends` (`src/modules/semantic/backend/index.ts`) is built once per process by `startNeuroVaultServer` and hands the registry its `semanticBackendFactory`. For each vault:

| Vault | Backend |
| --- | --- |
| `"semantic": false` | `createDisabledSemanticBackend()`: `status()` is `disabled`, every read rejects with `CorpusNotReadyError` carrying that status. It never attaches, so neither the daemon nor this process watches or indexes the vault. |
| `--no-shared` | `createLocalSemanticBackend`, over the process's in-process `VaultEntries`. |
| default (`--shared`) | `createDaemonSemanticBackend`, the facade onto the daemon's vault entry, which turns into the in-process backend for good once the process's switch goes `local`. |

### The daemon facade

`createDaemonSemanticBackend` (`daemon-backend.ts`) forwards to the daemon's `vault` and `corpus` services ([`shared-daemon.md`](./shared-daemon.md#the-vault-service)) over the process's one connection, `ISharedServices` ([`shared-daemon.md`](./shared-daemon.md#the-session-side-facades)). Every call first runs `services.ensure()`.

- **Attach once per connection epoch.** Before its first call on a connection, the facade sends `vault.attach { vault: <vault root>, profiles: [<this session's profile>] }`; concurrent callers share that one attach, and a reconnect (a new `DaemonConnection.epoch`) attaches again. Every later call carries the realpath key the daemon answered with. An attach answer that lands after the connection was replaced records nothing.
- **`status()`.** While this epoch's attach is in flight it answers `{ state: 'indexing', indexed: 0, total: 0 }` without waiting. With no attach on this epoch yet, it attaches and answers with the attach's status for the profile. After that it sends `vault.status` on every call. A status that cannot be read is `unavailable` for that call only: `reason: "daemon did not answer"` for a timeout (`DaemonTimeoutError`), the error's message otherwise (a dropped connection, say). The next call reads again, through a reconnect if the connection is gone.
- **Reads** are `corpus.nearest` and `corpus.nearestBlocks`, with vectors sent as plain JSON number arrays. A `CORPUS_NOT_READY` answer rejects with `CorpusNotReadyError` carrying the daemon's `data.status`. An attach refused with `VAULT_UNAVAILABLE` rejects a read with `CorpusNotReadyError({ state: 'unavailable', reason })`, and the next call attaches again. Any other failure (`CORPUS_FAILED`, `NOT_ATTACHED`, a timeout, a dropped connection, an answer without one list per anchor) rejects as itself; `NOT_ATTACHED` also forgets the attach, so the next call makes a new one.
- **Timeouts** (`CORPUS_TIMEOUTS`): `vault.attach` 10 s, `vault.status` 10 s, `corpus.*` 30 s. A request that runs out rejects; the connection stays up.
- **After the switch.** Once `services.ensure()` answers `local` (the daemon could not be located or started), every call goes to an in-process backend for the same vault, built on the first call that needs it.
- **`dispose()`** disposes that in-process backend if one was built. The connection is the process's, and closing it is the server's job (below).

### The in-process backend

`createLocalSemanticBackend` (`local-backend.ts`) runs the vault entry inside the session: the same `VaultEntries` module the daemon runs ([`vault-entry.md`](./vault-entry.md)), so the vault's scope, watcher, reconcile loop and corpus live in this process instead.

- Every vault of the process attaches under one fixed connection id (`LOCAL_CONNECTION_ID`, 0). The first call attaches; concurrent first callers share that attach, and `status()` reads `indexing` 0/0 while it is in flight. A vault that cannot be attached (`VAULT_UNAVAILABLE`) reads `unavailable` with the reason and is attached again on the next call.
- Reads refuse with `CorpusNotReadyError` carrying the profile's status unless it is `ready`, as the daemon's corpus service answers `CORPUS_NOT_READY`, so a caller sees one error vocabulary whichever side serves the vault.
- The process's `VaultEntries` is built on first use, so a session the daemon serves never builds a watcher, a reconcile loop or a corpus. Its entries embed documents through the session's own queue (`asDocumentEmbedFn`), for the session's one profile only, and never idle out (`idleTimeoutMs: 0`): the session holds them for its whole life. Under `--no-shared` every vault's backend is built over it at startup.
- `dispose()` releases nothing of its own: the entries are the process's, disposed by `createSemanticBackends().dispose()`. Once that has run, no backend builds them again; a backend that would need them reads `unavailable` and fails its reads.

## Startup: every vault attaches in the background

`VaultRegistry.create` never awaits a backend, so server startup is not gated on any vault's corpus. Right after the transport connects, `startNeuroVaultServer` (`src/server.ts`) issues one `status()` per vault that has a backend, and awaits none of them. A daemon facade's first `status()` sends `vault.attach` (connecting to, or spawning, the daemon first); an in-process one attaches its entry; the disabled backend answers at once. Every corpus therefore starts loading or building before the first tool call, and in practice the process's switch is decided then too. A tool call that arrives once the `vault.attach` request is in flight reads `indexing` 0/0; one that arrives while `services.ensure()` is still locating or spawning the daemon waits for it first (up to the 10 s spawn poll), since `status()` settles the switch before it looks at the attach.

Those same reads decide the embedding warmup: the model is warmed only when at least one vault's status is not `disabled`, and not after teardown has begun.

## Who reads the state

Three tools, two postures:

- **`search_notes`** never fails on backend state. It reads `status()` once per call into a `semantic_status: { state, indexed?, total? }` field that rides on every response, in every mode, including `mode: "lexical"` and the empty-filter early return: the field describes the vault's index, not whether this request touched it. Anything other than `ready`, and an absent backend (read as `disabled`), makes the call run its lexical leg only.

  Degradation also covers the leg failing on a backend that _reported_ `ready`: a rejected query embedding, or a corpus read that failed. The lexical matches are already computed, so the call returns them, writes the cause to stderr, and reports a `semantic_status` that describes the response the client is holding. When the failure is a `CorpusNotReadyError` (the corpus stopped serving between the status read and the leg, `indexing` after a daemon respawn, say), it reports the status that error carries; for any other failure it reports `unavailable`. A failure _outside_ the semantic leg (the wikilink graph, the filter set) still errors.
- **`get_similar_notes`** and **`find_duplicates`** have no non-semantic leg, so they fail structurally instead. Both are built with `buildSingleVaultTool`'s `semantic: true` variant (`src/lib/single-vault-tool.ts`), which resolves their vault through `resolveSemanticVault` (`src/lib/resolve-vault.ts`) before the per-vault function runs ([`fan-out.md`](./fan-out.md#the-two-dispatch-builders)). It awaits `status()` once per call and maps a vault that is not `ready` through `semanticReadinessError`:

  | `status().state` | Error code | `details` |
  | --- | --- | --- |
  | `indexing` | `SEMANTIC_INDEX_BUILDING` | `{ vault, indexed, total }` |
  | `disabled` | `SEMANTIC_DISABLED` | `{ vault, hint }` naming the config key |
  | `unavailable`, or `entry.backend` absent | `SEMANTIC_INDEX_NOT_FOUND` | `{ vault, reason, hint }`: the backend's reason, and a `hint` whose text is `build it with: neuro-vault-mcp index --vault <path>`, with no `--model`; a reader running it adds their server's own `--model`, so that `index` and the server agree |
  | `ready` | the call proceeds | — |

  An absent backend (semantic module off server-wide) is folded into the `unavailable` branch with a fixed reason: from a caller's point of view "no backend" and "a backend that never became usable" need the same response. A read that the corpus refuses _after_ the gate let the call in (`CorpusNotReadyError`) is mapped through the same `semanticReadinessError`, so it reports the same codes as the gate. Any other read failure is a `DEPENDENCY_ERROR`.

## The embed queue

One `QueuedEmbedder` (`src/modules/semantic/embed-queue.ts`) wraps the process's embedding provider in a FIFO queue with two lanes. The provider is the daemon facade by default and an in-process `EmbeddingService` with `--no-shared` or once the switch went `local` ([`embedding-pipeline.md`](./embedding-pipeline.md#where-the-model-lives)):

- `embedQuery` enqueues on the **query lane**: the retrieval path (`asProvider()`, wired into `search_notes`, `get_similar_notes` and `find_duplicates`) uses it.
- `embedDocuments` enqueues one entry per length bucket on the **index lane**: in-process indexing (`asDocumentEmbedFn()`, wired into the in-process vault entries) hands it each note's text and blocks in one call, which the queue splits into length buckets (at most 8 texts each, the longest at most twice the shortest, [`embedding-pipeline.md`](./embedding-pipeline.md#batching)). Each bucket is one forward pass. A blank text rejects the call up front, naming its index in the caller's input. Once one bucket fails, the call's still-queued buckets skip their forward pass.

The pump always drains the query lane first. A query issued while a vault is cold-indexing waits for at most the one batch already in flight (roughly half a second for a typical batch on `harrier-270m`, a bake-off estimate; a full 8 × 512-token batch takes longer), never behind the thousands of queued indexing batches.

With the daemon there are two queues of the same kind, one in front of the other ([`shared-daemon.md`](./shared-daemon.md#the-embed-service)):

- **This process's queue**, in front of the facade. It buckets by length with the batch size the daemon reported and keeps one request in flight per process. A server session served by the daemon sends it only queries, because its vaults are indexed in the daemon; an `index` run sends its document batches through it too.
- **The daemon's queue**, one per loaded profile. It orders requests from every connected client, and the vault entries' indexing through the same documents lane (`embed.documentsFor`), so one session's query waits for at most the one batch in flight, not for any vault's queued indexing.

## Teardown

`startNeuroVaultServer` builds a `dispose()` and chains it onto the MCP SDK's own `transport.onclose` (never replacing it), and reads end of input on stdin as the client hanging up ([`mcp-server-shape.md`](./mcp-server-shape.md#startup-and-shutdown-own-background-work)). It never rejects, and runs, in order:

1. **Close the shared services** (`services.close()`). Closing the daemon connection detaches this session from every vault entry it attached, and rejects whatever request was still pending on it, so a cold `embed.initialize` cannot hold the process open. It is final: a later `ensure()` rejects with `SharedServicesClosedError`, and a connect still in flight stops where it is — its poll timers are cleared, nothing is spawned after it, and a socket that connects after it is destroyed — so a status read that was waiting on the daemon cannot reconnect, attach or fall back for a session already gone.
2. **Dispose every vault's backend** (`backend?.dispose()`), through `Promise.allSettled`, so one vault's failure is written to stderr without blocking the others.
3. **Dispose the in-process vault entries** (`backends.dispose()`), if any vault ever needed them: every watcher closes, retry and idle timers clear, and the pass in flight is aborted. A cold pass is thousands of reads and embeds, each an active libuv request, so the loop passes an `AbortSignal` into reconcile, which checks it at each note boundary; shutdown is bounded by the single note in flight. From then on nothing builds the entries again.

A session the daemon serves holds no watcher and no timer of its own, so for it the first step is all the work; the daemon's entry outlives the session by its idle timeout ([`vault-entry.md`](./vault-entry.md#idle-per-entry-and-per-corpus)).

## Boundaries

This page is about the session's side only. The corpus lifecycle (startup selection, the reconcile loop, the watcher, the excluded-path fold, idle) belongs to [`vault-entry.md`](./vault-entry.md); extraction, the shard and manifest format, scoring and the reconcile algorithm to [`own-corpus.md`](./own-corpus.md); the wire protocol and the connection to [`shared-daemon.md`](./shared-daemon.md). Ranking, fusion and the quick/deep modes belong to [`retrieval-policy.md`](./retrieval-policy.md) and [`rank-fusion.md`](./rank-fusion.md): this backend hands them an `ICorpusReader` and nothing more.
