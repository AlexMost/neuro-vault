# The Semantic Backend

The per-vault seam a session's semantic tools read through: the `ISemanticBackend` contract, its implementations (one view over the vault's client, whichever side serves the vault, and the backend of a vault that opted out), the vault client under it, how a vault's status is read and mapped to tool behaviour, the vault attachment its lexical reader shares, the background attach at startup, the embed queue, and teardown. The corpus behind it, with its startup selection, per-note writes, freshness and retries, belongs to the vault entry, documented in [`vault-entry.md`](./vault-entry.md). The session holds no vector, no watcher and no reconcile loop of its own, except when it runs the vault entry itself as the fallback. The decisions are [ADR-0013](../adr/0013-own-embedding-corpus.md) (the server owns a corpus), [ADR-0019](../adr/0019-embedding-storage-interface.md) (sessions read the corpus, never its vectors) [ADR-0020](../adr/0020-per-vault-state-in-the-daemon.md) (per-vault state lives in the daemon's vault entry) and [ADR-0021](../adr/0021-vault-client.md) (one vault client per vault root; the backend is a view over it).

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

`IRegisteredVault.backend?: ISemanticBackend` ([`vault-registry.md`](./vault-registry.md)) carries one per vault. It is absent only when the semantic module is globally off (`--no-semantic`): `get_similar_notes` and `find_duplicates` are not registered then, and `search_notes` (registered with the lexical leg only) reads the absent backend as `disabled`. A vault whose `.neuro-vault/config.json` sets `"semantic": false` still gets a backend, the disabled one below. Every vault, with the module on or off, also carries `IRegisteredVault.lexical`, the reader of the lexical leg ([`lexical-search.md`](./lexical-search.md#who-holds-the-cache)).

`disabled` and `unavailable` mean different things and must never be confused: `disabled` is a deliberate choice (the vault turned semantics off); `unavailable` is broken (a pass failed, nothing usable was ever built, the vault directory is gone, or the status could not be read). No backend and no vault entry reports a failure as `disabled`.

## Two implementations, one factory

`createVaultClients` (`src/modules/semantic/vault-client/index.ts`) is built once per process by `startNeuroVaultServer`, when the semantic module is on, and hands the registry its `semanticBackendFactory` and its `lexicalReaderFactory` (below). For each vault the semantic factory returns:

| Vault | Backend |
| --- | --- |
| `"semantic": false` | `createDisabledSemanticBackend()`: `status()` is `disabled`, every read rejects with `CorpusNotReadyError` carrying that status. It never attaches by itself — the vault's lexical reader attaches it with no profile ([The vault clients](#the-vault-clients)) — so neither the daemon nor this process watches or indexes it. |
| `--no-shared` | `createSemanticBackendView` over the vault's in-process client ([The in-process side](#the-in-process-side)). |
| default (`--shared`) | `createSemanticBackendView` over the vault's daemon client, which serves the vault in-process for good once the process's switch goes `local`. |

The two enabled backends are one view over two clients; nothing in the backend knows which side serves the vault.

### The view

`createSemanticBackendView(client, profile)` (`view.ts`) implements `ISemanticBackend` over the vault's `IVaultClient` ([The vault client](#the-vault-client)):

- **`status()`** is `client.status(profile)`.
- **Reads** are `client.call('corpus.nearest', …)` and `client.call('corpus.nearestBlocks', …)` with the profile added, vectors sent as plain JSON number arrays, path sets as arrays and no `undefined` keys. An answer without one list per anchor rejects.
- **The one mapping it owns.** A `CORPUS_NOT_READY` answer rejects with `CorpusNotReadyError` carrying the answer's `data.status`; a `VAULT_UNAVAILABLE` (an attach the entry refused) with `CorpusNotReadyError({ state: 'unavailable', reason })`. Any other failure (`CORPUS_FAILED`, `NOT_ATTACHED`, `INVALID_PARAMS`, a timeout, a dropped connection) rejects as itself.
- **`dispose()`** is `client.dispose()`.

### The vault client

`IVaultClient` (`src/modules/semantic/vault-client/`) is one vault root on one side, the daemon's socket or the in-process loopback, and the one path the vault's semantic backend and its lexical reader take to that vault's entry ([ADR-0021](../adr/0021-vault-client.md)): both are views over it ([The vault clients](#the-vault-clients)):

```typescript
interface IVaultClient {
  call<M extends VaultMethod>(method: M, params: VaultCallParams<M>): Promise<VaultCallResult<M>>;
  status(profile: string): Promise<BackendStatus>; // never rejects
  warm(): Promise<void>; // attach now; never rejects
  dispose(): Promise<void>;
}
```

`VaultMethods` (`src/daemon/protocol.ts`) types `call`: one row per per-vault read (`corpus.nearest`, `corpus.nearestBlocks`, `lexical.search`), the wire's own params and result types, and `VaultCallParams<M>` is the row's params without `vault`, which the client adds. The core, `createLinkedVaultClient({ link, attachment })` (`client.ts`), runs over one link (`IVaultLink`: an `epoch` and a `request`):

- **Attach once per connection epoch.** Before its first call on a connection, the client asks the vault's attachment ([The vault clients](#the-vault-clients)) for the key, which sends `vault.attach { vault: <vault root>, profiles: [<this session's profile>] }`; concurrent callers share that one attach, and a reconnect (a new epoch) attaches again. Every later call carries the realpath key the entry answered with. An attach answer that lands after the connection was replaced records nothing.
- **`status(profile)`.** While this epoch's attach is in flight it answers `{ state: 'indexing', indexed: 0, total: 0 }` without waiting. With no attach on this epoch yet, it attaches and answers with the attach's status for the profile. After that it sends `vault.status` on every call. A status that cannot be read is `unavailable` for that call only: `reason: "daemon did not answer"` for a timeout (`DaemonTimeoutError`), the error's message otherwise (a dropped connection, an attach refused with `VAULT_UNAVAILABLE`, say). The next call reads again, and attaches again if no attach stands on the current epoch.
- **`call`** sends the method with the key and rejects as the answer does, unmapped; a `NOT_ATTACHED` (from a call or a status) also forgets the attach, so the next call makes a new one.
- **Timeouts** (`VAULT_CALL_TIMEOUTS`, `vault-client/timeouts.ts`): `vault.attach` 10 s, `vault.status` 10 s, every other method the 30 s default, so a new row needs no entry. A request that runs out rejects; the connection stays up.

The socket adapter, `createDaemonVaultClient({ services, attachment, local })` (`daemon-client.ts`), is that core over the process's one connection, `ISharedServices` ([`shared-daemon.md`](./shared-daemon.md#the-session-side-facades)), plus the switch:

- **The switch, consulted once for the vault.** Every call first runs `services.ensure()`, except a `status()` while the switch is undecided (below). Once `ensure()` answers `local` (the daemon could not be located or started), every call goes to the vault's in-process client, built on the first call that needs it.
- **While the switch is undecided** (`services.mode` is `pending`: the first `ensure()` is locating or spawning the daemon), `status()` answers `indexing` 0/0 without waiting and starts, or joins, a background `ensure()` that then attaches on the decided side. Should the services close under that connect, the switch stays undecided and later statuses read `unavailable` with the closing reason. Once decided, a status that finds the connection gone waits for the reconnect, then reads through the core; a connect that fails reads `unavailable` for that call.
- **Transport failures** (`DaemonTimeoutError`, `DaemonConnectionError`, `SharedServicesClosedError`) reach the views only through this adapter; the in-process side has no transport to fail. None of them flips the switch: only `ensure()` does.
- **`dispose()`** disposes the in-process client if one was built. The connection is the process's, and closing it is the server's job (below).

### The in-process side

The in-process client is the same core over a loopback link instead of the socket: there is nothing left to adapt. The loopback (`createInProcessLink`, `vault-client/link.ts`) calls the daemon's own `vault`, `corpus` and `lexical` handlers, the map `createVaultEntryServices` builds (`src/daemon/services/vault-entry-services.ts`), over this process's own `VaultEntries`: the same module the daemon runs ([`vault-entry.md`](./vault-entry.md)), so the vault's scope, lexical cache, watcher, reconcile loop and corpus live in this process instead.

- **One error vocabulary.** The loopback resolves `<namespace>.<method>` as the daemon's registry does and answers as the wire would: the handler's `DaemonRpcError` as it is, `UNKNOWN_METHOD` for a method that does not exist, `INTERNAL` with the message for any other throw. The handlers validate the same params the daemon does, and a read the corpus cannot serve yet answers `CORPUS_NOT_READY`, so a caller sees one error vocabulary whichever side serves the vault. The loopback ignores timeouts and its epoch never changes, so a vault attaches once, unless that attach fails or a `NOT_ATTACHED` forgets it.
- **One loopback per process**, shared by every vault's in-process client, as the daemon side shares one connection. The loopback is one client of the entries, under an id of its own (a counter in `link.ts`), so its attaches are kept and released together, as a daemon connection's are: closing it detaches it from every entry.
- The process's `VaultEntries` and the loopback are built on first use, so a session the daemon serves never builds a watcher, a reconcile loop or a corpus. The entries embed documents through the session's own queue (`asDocumentEmbedFn`), for the session's one profile only, and never idle out (`idleTimeoutMs: 0`): the session holds them for its whole life. Under `--no-shared` every vault's backend and lexical reader is built over them at startup.
- A client's `dispose()` releases nothing of its own: the loopback and the entries are the process's, closed by `createVaultClients().dispose()`. Once that has run, nothing builds them again; a backend that would need them reads `unavailable` and fails its reads, and a lexical reader fails its searches.

### The vault clients

Two views read one vault: its semantic backend and its lexical reader ([`lexical-search.md`](./lexical-search.md#who-holds-the-cache)). `createVaultClients` builds one client per vault root and side, on the first factory call for that root, and both views are built over it, so they share its one **attachment** (`vault-client/attachment.ts`, `IVaultAttachment`, built by `createAttachment` over the side's link): a vault makes one `vault.attach` per connection epoch whichever view calls first, and a respawned daemon sees one attach followed by both a `corpus.*` and a `lexical.search` call. The attachment is what the client asks before every call:

- `key()` — the realpath key on the current epoch, attaching first when needed; concurrent callers share the attach, and a refused one (`VAULT_UNAVAILABLE`) rejects as it is. An answer that lands after the connection was replaced attached nothing on the new one, so `key()` attaches again on the current epoch and rejects once three answers in a row landed on replaced epochs.
- `forget()` — drops the attach after a `NOT_ATTACHED`, so the next `key()` attaches again.
- `attaching`, `attached` and `statusOf(profile)` — the state the client's `status()` rules read: `indexing` 0/0 while the attach is in flight, the attach's own answer for the first status after it.

The single flight per epoch is its own small primitive, `createEpochGate` (`vault-client/epoch-gate.ts`): concurrent passes on one epoch share a run, and a run that settles on a replaced epoch commits nothing. The attachment names `profiles: [<this session's profile>]` for a vault that takes part in semantic search and `profiles: []` for one with `"semantic": false`: that vault still attaches, for its lexical leg, and the entry indexes nothing and runs no watcher for it ([`vault-entry.md`](./vault-entry.md#the-watcher-follows-the-scope)). The registry passes the same `enabled` to both factory calls of a vault; were they ever to disagree, the first call's would win. `createVaultClients` returns `{ semanticBackendFactory, lexicalReaderFactory, dispose }`; under `--no-semantic` it is not built at all, so no attachment exists and nothing starts a daemon.

## Startup: every vault attaches in the background

`VaultRegistry.create` never awaits a backend, so server startup is not gated on any vault's corpus. Right after the transport connects, `startNeuroVaultServer` (`src/server.ts`) issues one `status()` per vault that has a backend and one `lexical.warm()` per registered vault, and awaits none of them. A backend's first `status()` attaches through its vault's client: over the daemon (connecting to, or spawning, it first) or through the in-process loopback; the disabled backend answers at once. A lexical reader's `warm()` is the same attach — shared, so a vault attaches once — and it is what attaches a `"semantic": false` vault, with no profile; the standalone reader of a `--no-semantic` session has nothing to warm. A shared session therefore starts the daemon for any registered vault, a `"semantic": false` one included (not under `--no-semantic` or `--no-shared`). Every corpus and lexical cache therefore starts loading or building before the first tool call, and in practice the process's switch is decided then too. A tool call that arrives before the attach answers reads `indexing` 0/0 at once, including while the first `services.ensure()` is still locating or spawning the daemon (up to the 10 s spawn poll): a `status()` with the switch undecided does not wait for it. Corpus reads (`nearest`, `nearestBlocks`) still wait, but `search_notes` runs none while the status is not `ready`.

Those same status reads decide the embedding warmup: the model is warmed only when at least one vault's status is not `disabled` (so a session whose vaults all opted out starts the daemon but never loads the model), and not after teardown has begun. A backend whose daemon client's switch is undecided reads `indexing`, which counts as a vault that embeds.

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

One `QueuedEmbedder` (`src/modules/semantic/embed-queue.ts`) wraps the process's embedding provider in a FIFO queue with two lanes. The provider is `DaemonEmbeddingProvider`, the daemon's embedding facade, by default and an in-process `EmbeddingService` with `--no-shared` or once the switch went `local` ([`embedding-pipeline.md`](./embedding-pipeline.md#where-the-model-lives)):

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
3. **Dispose the in-process vault entries** (`clients.dispose()`), if any vault ever needed them: every watcher closes, the lexical members are dropped, retry and idle timers clear, and the pass in flight is aborted. A cold pass is thousands of reads and embeds, each an active libuv request, so the loop passes an `AbortSignal` into reconcile, which checks it at each note boundary; shutdown is bounded by the single note in flight. From then on nothing builds the entries again.

A session the daemon serves holds no watcher and no timer of its own, so for it the first step is all the work; the daemon's entry outlives the session by its idle timeout ([`vault-entry.md`](./vault-entry.md#idle-per-entry-and-per-corpus)).

## Boundaries

This page is about the session's side only. The corpus lifecycle (startup selection, the reconcile loop, the watcher, the excluded-path fold, idle) belongs to [`vault-entry.md`](./vault-entry.md); extraction, the shard and manifest format, scoring and the reconcile algorithm to [`own-corpus.md`](./own-corpus.md); the wire protocol and the connection to [`shared-daemon.md`](./shared-daemon.md). Ranking, fusion and the quick/deep modes belong to [`retrieval-policy.md`](./retrieval-policy.md) and [`rank-fusion.md`](./rank-fusion.md): this backend hands them an `ICorpusReader` and nothing more.
