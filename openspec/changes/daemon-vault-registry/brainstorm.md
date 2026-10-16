# Brainstorm — daemon-vault-registry (#175)

Raw decision log. Path: **architectural** (a new daemon service with per-vault state, a new seam between the session and the corpus, a lifecycle that outlives the session, and the end of the session's own watcher, reconcile loop and snapshot).

Change 1 of the effort epic #158; change 2 is `daemon-lexical-search` (#176). Every decision below was made on the wayfinder map #160 and its tickets (#161–#166), in conversation with the owner, on 2026-10-15/16. This log collects them in one place, in the order the change needs them, and adds nothing the owner has not decided. No interactive brainstorming round was run: no fork is left open.

## Background

- **Today, per session.** `VaultRegistry` (`src/lib/vault-registry.ts`) builds one `SemanticBackend` per vault through `semanticBackendFactory` (`createOwnCorpusBackendFactory`, `src/modules/semantic/backend/index.ts`). Each backend (`createCorpusBackend`, `corpus-backend.ts`) runs its own chokidar watcher (`vault-watcher.ts`, with its own `isIgnoredPath` predicate), its own reconcile loop (`reconcileCorpus` under `acquireCorpusLock`, `src/lib/obsidian/corpus/`), and holds the whole decoded corpus in memory. `SemanticBackend { snapshot(), status(), dispose() }` (`src/lib/obsidian/semantic-backend.ts`) hands every tool the full `Map<path, SmartSource>` plus a `basenameIndex`; `search_notes` (`executeRetrieval`, `retrieval-pipeline.ts`), `get_similar_notes` and `find_duplicates` rank by iterating it through `SearchEngine`.
- **Today, the daemon** ([ADR-0018](../../../docs/adr/0018-shared-services-daemon.md)): one process per installed version, a unix socket, newline-delimited JSON-RPC with the SDK's framing, namespaced services `daemon.*` and `embed.*`, `DaemonErrorCode = UNKNOWN_METHOD | INVALID_PARAMS | UNKNOWN_PROFILE | EMBED_FAILED | SHUTTING_DOWN | INTERNAL`. On the session side, `DaemonConnection` (`src/modules/semantic/daemon-connection.ts`) is built by `provider-factory.ts` for `DaemonEmbeddingProvider`, with a one-way fallback to the in-process provider. Standing constraint: a new shared capability is a namespaced service + a session-side facade + an in-process fallback; no new protocol, process or port.
- **Measured cost** (baseline on #158, build 17.1.1, ~955-note vault, `harrier-270m`): each extra semantic session settles at ~156 MB footprint against ~63 MB at the `--no-semantic` floor, so ~93 MB per session is per-vault semantic state that can be held once. The daemon sits at ~223 MB, flat across N.
- **Already decided and merged.** [ADR-0019](../../../docs/adr/0019-embedding-storage-interface.md) (#168, amended in #170): the corpus is an interface inside the daemon; sessions read it and never its vectors. `GLOSSARY.md` defines **corpus**, **vault entry** and **attach** (#168, #173). #169 handles a `ReadBuffer` overflow per connection. #174 expands a bare config exclusion (`"Archive"`, `"**/drafts"`) to `X` + `X/**`, which the watcher below relies on.

## Settled by the map's charting (2026-10-15, not revisited)

1. **Fallback** is decided once per process at first use, as the `embed` facade does. A daemon that dies mid-session is an error retried on the next call; the session never re-materialises watcher or corpus. `--no-shared` keeps the full in-process path.
2. **One reconcile loop per vault directory**, iterating every attached profile under one acquisition of the reconcile lock, so the lock's "passes never overlap within a process" assumption stays true.
3. **A vault entry outlives its last client** by the daemon's `--idle-timeout`: a per-entry idle timer, same value, no new flag.
4. **Scope** (`.gitignore` + `.neuro-vault/config.json` exclusions) is re-read on every `vault.attach`. Nothing watches those files.
5. **Filters stay in the session.** It computes the `allowed` path set and sends it with the query. Fusion, `filterExisting` and backlink counts stay in the session. The daemon serves the corpus's reads, not legs or fused results (revised by #164).
6. **#106** (the watcher uses the vault scope instead of its own predicate) folds into this change.
7. **`neuro-vault-mcp index`** stays in-process under the existing reconcile lock.
8. **Keying**: the realpath of the vault directory; scope comes from the vault's own files, so it is the same for every session on that directory.

## Decision chain

### Q1. What does the daemon hold, and what is it called?

The **vault entry**: the daemon's shared state for one vault directory, holding its scope, its watcher, its reconcile loop and its corpora (one per attached profile). Change 2 adds the lexical cache to it. A session **attaches** to an entry. The daemon keeps a registry `realpath → vault entry`; the registry is what keeps the reconcile loop unique per vault in the daemon. (#162; glossary in #173.)

The in-process fallback runs **the same vault-entry module** (watcher, reconcile loop, corpora) inside the session. The daemon and the fallback differ only in the facade the session talks to.

### Q2. `vault.attach`: params, result, semantics

| Method | Params | Result | Timeout |
|---|---|---|---|
| `vault.attach` | `vault` (absolute path), `profiles: string[]` (may be empty) | `{ vault: <realpath>, profiles: { [profile]: BackendStatus } }` | 10 s |

- The daemon realpaths the path itself and keys the entry by it. Every later call (`vault.status`, `corpus.*`, later `lexical.search`) carries the returned key.
- **Nothing session-specific is sent.** Scope and the `"semantic"` key are re-read from the vault's files on every attach, so `disabled` arrives per profile in the result. No corpus identity in the result: the daemon runs the same build as the session, so the identity is the same (ADR-0019).
- `profiles: []` is valid: change 2's `lexical.search` needs an attach for a vault whose semantic search is disabled (input from #165).
- **Idempotent and additive per connection.** The facade re-sends it once per connection epoch, as `embed.initialize` is re-sent.
- **Returns at once.** The warm load of each corpus and the first reconcile pass run in the background.
- **An attach that changes the scope** restarts the entry's watcher, queues a pass, and applies the new scope to reads at once. Already-attached sessions keep their own startup scope for their own tools until they restart.

### Q3. Detach, refcount and idle

- **No `vault.detach`.** A closed connection is the only detach. An entry's clients are the connections that attached it.
- The entry, **and each (vault, profile) corpus inside it**, outlives its last client by `--idle-timeout`, with its own timer for each. An idle corpus leaves the reconcile loop and frees its vectors; an idle entry stops its watcher and is dropped.
- **No cap, no eviction.** Each attached profile costs one decoded corpus; that is the accepted cost of a second `--model`.

### Q4. How does a session observe status?

| Method | Params | Result | Timeout |
|---|---|---|---|
| `vault.status` | `vault` (realpath), `profile` | `BackendStatus` | 10 s |

- **Pull, no notifications.** The protocol stays request/response.
- `SemanticBackend.status()` becomes `Promise<BackendStatus>`. Call sites: `resolveSemanticVault` (the readiness gate: `SEMANTIC_INDEX_BUILDING` / `SEMANTIC_INDEX_NOT_FOUND` / `SEMANTIC_DISABLED`), `search_notes`' `semantic_status`, and the startup warmup.
- The daemon facade calls `vault.status` once per semantic tool call. Until the startup attach has answered, `status()` reads `indexing 0/0`.
- A `vault.status` timeout counts as `unavailable` ("daemon did not answer") for that call only: the semantic leg is `failed` and the search degrades to lexical.
- **Lifecycle state belongs to the vault entry**, not the corpus: `indexing | ready | unavailable | disabled`, as `BackendStatus` reports today. Pass counters come from the pass, `disabled` from config, `unavailable` from a failed pass or a corpus that throws. The corpus reports only `identity()`. (ADR-0019.)

### Q5. Error codes

`DaemonErrorCode` gains, and `errorResponse` gains an optional `data`:

| Code | When | Session does |
|---|---|---|
| `NOT_ATTACHED` | `vault.status` / `corpus.*` / `lexical.search` for a pair this connection did not attach | a facade bug → `DEPENDENCY_ERROR` |
| `VAULT_UNAVAILABLE` | attach could not realpath the path, or it is not a directory | the vault reports `unavailable` with the reason; the next call that needs it attaches again. Not a fallback |
| `CORPUS_NOT_READY` | the entry is not `ready`; `data.status: BackendStatus` | mapped like the readiness gate; in `search_notes` the semantic leg is `failed` and the search degrades to lexical |
| `CORPUS_FAILED` | the corpus threw (later: an unreachable remote store) | `DEPENDENCY_ERROR` |

`INVALID_PARAMS` covers a vector anchor whose length is not the identity's `dims`; `UNKNOWN_PROFILE` and `SHUTTING_DOWN` keep their `embed.*` meaning. No `UNKNOWN_VAULT`: it was ambiguous between "never attached" and "not a directory", which the two codes above separate. `LEXICAL_FAILED` belongs to change 2. (#162, #164.)

### Q6. Fallback and the connection

- **One `DaemonConnection` per process**, shared by every facade (`embed`, `vault`, `corpus`, later `lexical`), with **one one-way switch**. Today the connection is built for the embedding provider alone; it moves up so every facade shares it.
- Sessions **attach every vault eagerly at startup, in the background**. So the first `DaemonUnavailableError` decides the fallback at startup and flips the whole process in-process, before any tool call.
- After that, a timeout or a dropped connection fails the call that hit it and is retried on the next call; it never switches to the fallback (as in `DaemonEmbeddingProvider`).
- `--no-shared` selects the in-process vault entry up front.

### Q7. The reconcile loop

- **One loop per entry.** A pass takes the reconcile lock once and walks the attached profiles **in attach order**.
- A cold build of one profile delays the other profiles' catch-up; they stay `ready` meanwhile.
- A profile attached mid-pass is picked up by the next pass (dirty flag, as `currentPass` + `dirty` work today).
- The registry keeps the loop unique per vault in the daemon, so the same-pid stale rule of `reconcile-lock` holds.
- `neuro-vault-mcp index` stays in-process under the same lock. After such a run the entry's corpus calls `refresh()` to re-read the durable form.
- Upgrade overlap (an old and a new daemon each reconciling a directory until old sessions end) is accepted in ADR-0018 and bounded by the lock.

### Q8. The watcher (#106)

- chokidar 4 prunes a whole subtree when `ignored` returns true for a directory, and its `stats` argument is unreliable. So `ignored` prunes **only provably excluded subtrees**: a dot segment, or a match against the scope's `/**` patterns, through a new **`scope.isSubtreeExcluded(relDir)`**.
- The event handler forwards a path only when it ends in `.md` and `!scope.isExcluded(rel)`. Pruning on `isExcluded(dir)` would hide in-scope notes for `Archive/*` (one level) or for a bare `Archive` before #174.
- Since #174, a bare config exclusion expands to `X` + `X/**`, so it prunes too. A wildcard entry like `Archive/*` is filtered per file, not pruned.
- From #106, still binding: `isExcluded` takes a vault-relative POSIX path while chokidar hands absolute native paths, so the conversion gets a table test with a Windows-style input; the watcher is handed the scope object and never re-derives the test; a watcher that fails to start still degrades to reconcile-on-start with a stderr warning.
- Nothing watches `.gitignore` or `config.json` (charting point 4).

### Q9. The corpus inside the entry (ADR-0019)

- **One corpus per (vault realpath, profile)**: the note and block vectors of one vault under one profile, plus change-detection metadata (`content_hash`, `mtime`, `size`) as payload.
- **Reads** (vectors in, paths and scores out), each over an **anchor** (a query vector, or a note path whose own vector the corpus uses): `nearest(anchor, { threshold, limit?, allowed?, exclude? })`, `nearestBlocks(anchor, { paths, threshold, limit? })`, and `vectorOf(path)`, which resolves a path anchor inside the corpus and never answers a session.
- **Writes** (all reconcile needs): `entries()` (metadata, no vectors; replaces the full parsed shard listing), `upsert(record)`, `touch(path, { mtime, size })`, `delete(path)`, `identity()` / `reset(identity)`, `refresh()`. No rename: a rename is upsert plus delete.
- **Writes are visible per note**; no pass-level atomic promotion. The `indexing` gate covers the cold build; an identity change empties the corpus before the first write under the new identity, so dimensions never mix.
- **First implementation:** the per-profile shard files of ADR-0013 / ADR-0017, format unchanged (the durable form `index` shares with the daemon), plus decoded `Float32Array`s that update per write instead of re-decoding after a pass. `CorpusStore` becomes **`ShardStore`**, this implementation's durable layer. `SearchEngine`'s brute-force functions become its internals and leave the tools' dependencies.
- **The corpus does not know the scope.** The vault entry folds the scope's exclusions into `allowed` / `exclude` before any limit, so a scope change never starves a result; reconcile keeps sweeping excluded notes as orphans.

### Q10. `corpus.*` on the wire

Params are snake_case. Every call carries `vault` (realpath) and `profile`; the connection must have attached that pair.

| Method | Params | Result | Timeout |
|---|---|---|---|
| `corpus.nearest` | `anchors`, `threshold`, `limit?`, `allowed?: string[]`, `exclude?: string[]` | `{ hits: ({path, similarity}[] \| null)[] }` | 30 s |
| `corpus.nearestBlocks` | `anchors`, `paths: string[]`, `threshold`, `limit?` | `{ hits: ({path, heading, lines, similarity}[] \| null)[] }` | 30 s |

- An anchor is `{ vector: number[] }` (from `embed.query`) or `{ path }`. `hits` holds one list per anchor, in order: `null` = a path anchor with no vector (not in the corpus, or too short); `[]` = nothing above the threshold.
- Note vectors never leave the daemon. The daemon yields to the event loop between the anchors of one call.
- The daemon serves only what a hosted vector store could take over; retrieval policy stays in the session. (#164, ADR-0019 as amended.)

### Q11. The session side: `SemanticBackend` and the three tools

- `SemanticBackend` = `CorpusReader { nearest, nearestBlocks }` + `status()` + `dispose()`. `snapshot()` goes; `SearchEngine` leaves the tools' deps. Two implementations: the daemon facade and the in-process fallback over an in-memory corpus.
- **`search_notes`**: `executeRetrieval` takes `CorpusReader` + `QueryEmbedder` instead of `sources` + `SearchEngine`. Per search: `embed.query` per query → `nearest` (query vectors, `allowed`, `limit + 1`; again at the fallback threshold for empty queries) → `nearestBlocks` (query vectors, `paths` = seeds) → backfill `nearestBlocks` (`paths: [seed]`, `limit: 1`, `threshold: 0`) → expansion `nearest` (`{path: seed}` anchors, `exclude` = seeds, `allowed`). `RetrievalOutput` is unchanged; `runRetrievalPipeline` swaps `snapshot` + `searchEngine` for the backend. Fusion, `filterExisting`, backlink counts and the wikilink graph stay in the session.
- **`get_similar_notes`**: one `nearest` (`{path}` anchor, `threshold`, `exclude: [path]`, no `limit`: the threshold bounds it, as today). `null` → `NOT_FOUND`. `exclude_folders`, forward links, `filterExisting`, sort and `limit` stay in the session. Forward links resolve through the **session's vault-wide basename index** (the one `get_note_links` uses), not corpus paths, so a link to a note too short to carry a vector now reports `forward_link` instead of being dropped.
- **`find_duplicates`**: the session sends its scoped path list as `{path}` anchors in batches of 64, skips `null`, folds symmetric pairs, then `filterExisting`. About twice the cosine work of today's triangular loop; accepted for a rarely used hygiene tool.
- A search costs several socket round trips (query embedding, seeds, blocks, backfill, expansion); accepted for a daemon that a hosted store can replace.

### Q12. Payload sizes and framing (#163)

No new framing. `allowed` for 1,000 notes is 44–69 KiB as JSON and 0.03–0.06 ms to stringify; a semantic leg at the `deep` effort profile is 5–11 KiB. Both are below the `embed.documents` batches already on the wire (99–158 KiB). The session sends `allowed` once per search request as a JSON array; results serialise as the in-process types. The SDK's `ReadBuffer` cap and per-connection overflow handling are #169's, already merged.

### Q13. `daemon status`

`daemon.info` gains `services.vault: [{ vault, clients, idle_since?, profiles: [{ profile, state, indexed?, total?, notes?, last_reconcile?: { at, added, changed, removed, ms } }] }]`. `daemon status` prints one line per entry under the daemon line (clients, or idle time at zero clients), then one per profile (state, notes or `indexed/total`, last reconcile). Change 2 adds the lexical cache line.

### Q14. Delivery: two PRs, no transitional window

| PR | Content |
|---|---|
| 1 `Refs #158`, `Refs #175` | **Dark.** Vault registry and vault-entry module, watcher on the scope (`isSubtreeExcluded`), reconcile loop over the corpus interface (`ShardStore` + in-memory corpus), `vault.attach` / `vault.status`, the new error codes, `daemon status`. Tested without any session attaching. |
| 2 `Refs #158`, `Closes #175`, `Closes #106` | `corpus.*`, the shared `DaemonConnection`, the session facade and in-process fallback, eager attach at startup, async `status()`, the three tools over `CorpusReader`. The session drops its watcher, reconcile loop and snapshot in one step. Docs sweep, verify, retro, archive. |

PR 1 is dark, so there is no transitional window: no session ever holds a snapshot while the daemon reconciles for it, and no snapshot-reload mechanism is built. A release between the two PRs is harmless. #106 closes with PR 2, when the session's own watcher and its predicate are gone. (#162.)

### Q15. `npm run eval`

Runs in-process over the shard-backed corpus and the same leg composition. It measures ranking, not transport, so it never goes through the daemon (#161).

### Q16. Measurement

By hand on the owner's vault, the same method as the baseline on #158: N stdio sessions driven until `semantic_status.state = "ready"`, macOS physical footprint compared at +300 s (not `ps` RSS). After PR 2 the per-session figure is recorded on #158 against the settled table. No script in the repo and no CI gate. The end-of-effort percentage comes after change 2.

## Acceptance

- `npm test && npm run lint && npm run typecheck && npm run format && npm run build` pass on both PRs; the test count never drops.
- PR 1: a raw JSON-RPC client over the socket attaches a fixture vault and sees `vault.status` go `indexing` → `ready`; two connections on one vault share one entry (one watcher, one reconcile loop, `daemon status` shows `clients: 2`); an attach with `profiles: []` returns no corpus; a write in the vault triggers one pass; an edit under a `/**`-excluded subtree triggers none; a closed connection plus `--idle-timeout` drops the entry; `NOT_ATTACHED` and `VAULT_UNAVAILABLE` surface as specified.
- PR 2: N sessions on one vault → one watcher, one reconcile loop and one decoded corpus per profile in `daemon status`, and no watcher in any session; `search_notes`, `get_similar_notes` and `find_duplicates` return the same ranking as in-process (the short-note `forward_link` case aside); `npm run eval` scores do not move; `--no-shared` runs the same vault-entry module in-process; a daemon killed mid-session fails the next semantic call and does not re-materialise state in the session; per-session footprint recorded on #158.
- Docs: `docs/architecture/shared-daemon.md`, `own-corpus.md`, `semantic-backend.md`, `vault-registry.md`, `vault-scope.md`, `search-engine.md`, and a sweep of `docs/guide/`.

## Deferred to change 2 / out of scope

- **`lexical.search` in the daemon** → change 2, `daemon-lexical-search` (#176), blocked by this change. Decided in #165: one method, read-through freshness, one cache per entry over the whole scope, the entry's own wikilink graph for the backlink tie-break, a `LexicalReader` facade. This change only makes `vault.attach` accept `profiles: []` for it.
- **Shrinking the lexical cache** (#171): drop the per-character offset map from `ParsedNote`; a direct PR independent of the move.
- **The wikilink graph and its consumers in the daemon** (#172): this effort keeps the graph in the session.
- **Startup peak** (metadata-only shard listing, shard-by-shard decode): independent of the move, its own issue. `entries()` without vectors is a step toward it for reconcile only.
- **A note-metadata index or `query_notes` in the daemon**: a later effort; filters stay in the session.
- **Watching `.gitignore` / `config.json`** for scope changes: a later issue if needed; scope is re-read on attach.
- **The `extract-retrieval-pipeline` tail** (#109): revisited separately.
- **A remote embedding provider or a third-party vector store**: the seams of ADR-0017 and ADR-0019 leave room for both; neither is built here. Nor is a new durable format.
