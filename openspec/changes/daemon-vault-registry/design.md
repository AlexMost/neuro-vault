## Context

The decisions are in `brainstorm.md` (Q1–Q16), taken from wayfinder map #160 and tickets #161–#166. This file turns them into a technical design and settles the implementation forks they left to the change: where the code lives, what the types are called, how a handler learns its connection, how reconcile is split around the lock, and how PR 1 stays dark.

**Today, per session** (v17.1.1). `VaultRegistry.create` (`src/lib/vault-registry.ts`) builds, for every configured vault, an `IVaultEntry` with scope, reader, graph and an optional `SemanticBackend` from `semanticBackendFactory`. Production's factory (`createOwnCorpusBackendFactory`, `src/modules/semantic/backend/index.ts`) builds a `CorpusStore`, a `createCorpusBackend` state machine (`corpus-backend.ts`: the four states, startup selection, one pass at a time with a dirty flag, retry backoff 30 s → 15 min, lock-timeout restore, abort on dispose) and a debounced chokidar watcher (`vault-watcher.ts`, `isIgnoredPath`). `reconcileCorpus` (`src/lib/obsidian/corpus/reconcile.ts`) takes the vault's cross-process lock, migrates a legacy layout, runs `ensureManifest`, scans, lists every shard parsed, and embeds, touches, renames and sweeps. After a pass that changed something, or that waited for the lock, the backend re-decodes the whole corpus (`loadCorpusSnapshot`) and swaps it in. Tools read `snapshot()` (`Map<path, SmartSource>` + `basenameIndex`) and rank through `SearchEngine` (`search-engine.ts`): `executeRetrieval` (`retrieval-policy.ts`) for `search_notes`, the note's own vector for `get_similar_notes`, all pairs for `find_duplicates`.

**Today, in the daemon** (ADR-0018). `src/daemon/`: a version-keyed unix socket, `ReadBuffer` framing, `ServiceRegistry` routing `<namespace>.<method>` to a `MethodHandler = (params) => Promise<unknown>`, services `daemon.*` and `embed.*`, a client counter and idle timer in `socket-server.ts`. Session side: `createEmbeddingProvider` (`provider-factory.ts`) builds a `DaemonConnection` and a `DaemonEmbeddingProvider` that owns its own one-way fallback.

**Constraints.** ADR-0018: a new shared capability is a namespaced service + a session-side facade + an in-process fallback; no new protocol, process or port. ADR-0019: the corpus interface (reads and writes), one corpus per (vault realpath, profile), scope folded into `allowed` by the vault entry, shard files as the durable form, status owned by the vault entry. Standing preferences: incremental delivery (this change is two PRs), storage-agnostic interfaces, manual memory measurement, the glossary's terms (`GLOSSARY.md`: corpus, vault entry, attach).

## Goals / Non-Goals

**Goals:**

- One watcher, one reconcile loop and one decoded corpus per profile per vault directory on a machine, whatever the number of sessions.
- Sessions hold no note vector, no watcher and no reconcile loop; their semantic memory is a facade.
- `search_notes`, `get_similar_notes` and `find_duplicates` rank exactly as in-process today (the short-note `forward_link` case aside); `npm run eval` scores do not move.
- The same vault-entry module runs in the daemon and in the in-process fallback, so `--no-shared` and the daemon cannot drift.
- PR 1 is mergeable and releasable alone with no behaviour change for sessions.

**Non-Goals:**

- `lexical.search` and the lexical cache (change 2, #176); the cache shrink (#171); the wikilink graph in the daemon (#172).
- The startup peak (metadata-only listing, shard-by-shard decode) beyond what `entries()` gives reconcile.
- A note-metadata index or `query_notes` in the daemon; filters stay in the session.
- Watching `.gitignore` / `config.json`; a remote provider or vector store; a new durable format.

## Decisions

### D1: Vault-entry module in `src/lib/vault-entry/`, type `VaultEntry`

- **Choice**: a new directory `src/lib/vault-entry/` holds `VaultEntry` (one vault directory: scope, watcher, reconcile loop, corpora per profile, clients, idle timers) and `VaultEntries` (the registry `realpath → VaultEntry`, the attach/status operations and the idle policy). The daemon's `vault` and `corpus` services and the session's in-process fallback both construct `VaultEntries`. The session's existing `IVaultEntry` (the per-session record built by `VaultRegistry`) keeps its name; it is the *registered vault*, not the shared state, and `GLOSSARY.md` already steers away from calling the shared thing a "vault registry entry".
- **Why**: the fallback must run the same code (brainstorm Q1), so the module cannot live under `src/daemon/`; `src/lib/` is where code shared by the daemon and the session already lives (`corpus/`, `vault-scope.ts`).
- **Alternatives**: `src/daemon/vault/` imported by the session (inverts the dependency direction: the session would import daemon internals); renaming `IVaultEntry` now (a repo-wide rename unrelated to the move).

### D2: Handlers get a per-connection context

- **Choice**: `MethodHandler` becomes `(params, ctx: ConnectionContext) => Promise<unknown>`, with `ctx = { id: number, onClose(fn): void }`. `startDaemonServer` creates one context per accepted socket and runs the `onClose` callbacks when the socket closes. `ServiceRegistry.dispatch(request, ctx)` passes it through. `embed.*` and `daemon.*` ignore it.
- **Why**: `vault.attach` is per connection (refcount, `NOT_ATTACHED`), and a closed connection is the only detach (brainstorm Q3). The socket server already owns the connection lifecycle.
- **Alternatives**: a connection id inside params (a client could forge another's id); a separate connection registry the vault service polls (two owners of one lifecycle).

### D3: The corpus interface and its first implementation

- **Choice**: `src/lib/obsidian/corpus/corpus.ts` declares the ADR-0019 interfaces:
  - `CorpusReader { nearest(anchor, opts), nearestBlocks(anchor, opts) }` with `anchor = { vector } | { path }`, returning `null` for a path anchor without a vector;
  - `CorpusWriter { entries(), upsert(record), touch(path, stat), delete(path), identity(), reset(identity), refresh() }`;
  - `Corpus = CorpusReader & CorpusWriter & { vectorOf(path), dispose() }`.
  `CorpusStore` is renamed `ShardStore` (file `shard-store.ts` keeps its name). `ShardCorpus` (`shard-corpus.ts`) implements `Corpus` over a `ShardStore` plus in-memory `Float32Array`s and metadata, loaded once by `load()` and updated per write (write the shard first, then memory). `shardWriter(store)` implements `CorpusWriter` over the `ShardStore` alone, with no memory: what `neuro-vault-mcp index` and PR 1's legacy session path use. `CorpusWriter` carries `ensureIdentity(expected)` (the stored identity checked and, on a mismatch, reset, composed in one call) in place of the separate `reset(identity)` the interface list above shows, so a writer never exposes a half-reset corpus. The brute-force scoring of `search-engine.ts` (cosine, ordering by similarity then `localeCompare` on path) moves into `ShardCorpus`'s internals, unchanged, so rankings are identical.
- **Why**: per-note visibility and `entries()` without vectors (ADR-0019); the disk-only writer keeps `index` from decoding a corpus it never reads.
- **Alternatives**: one class that lazily loads its memory side on first read (two modes in one type, and the legacy session path would still hold a second copy if anything read it).

### D4: Reconcile is split around the lock

- **Choice**: `reconcile.ts` exposes `withReconcileLock(vaultRoot, opts, fn)` (acquire, migrate legacy, run `fn`, release; abort and wait semantics unchanged) and `reconcileProfile(deps, corpus: CorpusWriter, paths, opts)` (the per-note loop and orphan sweep, reading metadata from `corpus.entries()` and writing through `corpus.upsert/touch/delete`; `ensureManifest` becomes `corpus.identity()` + `corpus.reset(identity)`). `reconcileCorpus` remains as `withReconcileLock` + one `reconcileProfile` over `shardWriter(store)`, so `index` and the legacy session path are behaviour-identical.
- **Why**: one loop per vault directory walks every attached profile under one acquisition of the lock (charting decision 2, brainstorm Q7); the scan is done once per pass and shared by the profiles, since the scope is the entry's.
- **Alternatives**: one lock acquisition per profile (breaks "passes never overlap within a process" across profiles of one entry).

### D5: The reconcile loop generalises `createCorpusBackend`

- **Choice**: `src/lib/vault-entry/reconcile-loop.ts` carries over today's state machine per profile: `BackendStatus` per profile, startup selection (a compatible manifest with shards → `load()` → `ready`), one pass in flight with a dirty flag, retry backoff (30 s doubling to 15 min) after an `unavailable` pass, lock-timeout restore of the previous state, and abort on dispose. A pass walks the profiles in attach order; a profile attached during a pass is picked up by the next one (dirty flag). A pass that waited for another holder calls `refresh()` on every profile's corpus before its own work. The "indexing produced no usable corpus" guard keeps its three clauses.
- **Why**: every rule in `createCorpusBackend` answers a past incident; moving it keeps them.
- **Alternatives**: rewrite the state machine for the multi-profile case (loses tested behaviour).

### D6: The watcher follows the scope (#106)

- **Choice**: `VaultScope` gains `isSubtreeExcluded(relDir)`: true for a dot segment, or when `relDir` matches the prefix of a pattern ending in `/**` (compiled once from `ignorePatterns`). `startVaultWatcher` takes the scope: chokidar's `ignored` returns true only for `isSubtreeExcluded(rel)` of a directory path (the vault root is never ignored), and the event handler forwards a path only when it ends in `.md` and `!scope.isExcluded(rel)`. `rel` is `relative(vaultRoot, p)` with separators converted to `/`. The `.tmp` clause is dropped: it never matched a `.md` file. The watcher moves to `src/lib/vault-entry/watcher.ts`.
- **Why**: chokidar 4 prunes a whole subtree when `ignored` is true for a directory and its `stats` argument is unreliable, so pruning on `isExcluded(dir)` would hide in-scope notes for `Archive/*` (brainstorm Q8). Since #174 a bare config entry expands to `X` + `X/**`, so it prunes.
- **Alternatives**: pass `isExcluded` as `ignored` (hides notes for one-level globs); keep the watcher's own predicate (two definitions of scope, the #106 problem).

### D7: `vault.attach` and `vault.status` in the daemon

- **Choice**: a `vault` service (`src/daemon/services/vault.ts`) over `VaultEntries`.
  - `attach({ vault, profiles }, ctx)`: realpath the path and check it is a directory (else `VAULT_UNAVAILABLE`); validate profiles against the registry (`UNKNOWN_PROFILE`); load config and scope from the vault's files; create the entry or reuse it; when the scope's patterns differ from the entry's, swap the scope, restart the watcher and queue a pass; add the connection to the entry's clients and to each profile's clients; register `ctx.onClose` once per connection; answer `{ vault: realpath, profiles: { [p]: status } }` without waiting for loads or passes. A profile is `disabled` when the vault's `"semantic"` key is false.
  - `status({ vault, profile }, ctx)`: `NOT_ATTACHED` unless this connection attached the pair; else the profile's `BackendStatus`.
  - The entry's corpus for a profile embeds through the `embed` service's queue for that profile (the documents lane), and its identity is `corpusIdentityOf(identityOf(profile))`.
- **Why**: brainstorm Q2, Q4, Q5; one queue per profile already orders queries ahead of documents across sessions.
- **Alternatives**: the session sends its scope (sessions could disagree; the key would no longer identify the state).

### D8: Idle per entry and per corpus

- **Choice**: `VaultEntries` keeps, per entry and per (entry, profile), the set of connection ids. When a set empties, a timer of the daemon's `--idle-timeout` starts (`0` = never); an attach before it fires cancels it. A fired corpus timer removes the profile from the loop and disposes its corpus (frees vectors); a fired entry timer stops the watcher and the loop and drops the entry. The daemon's own idle exit (no clients for the same timeout) is unchanged and disposes every entry.
- **Why**: brainstorm Q3; no new flag.

### D9: Error codes and `data`

- **Choice**: `DaemonErrorCode` gains `NOT_ATTACHED`, `VAULT_UNAVAILABLE` (PR 1), `CORPUS_NOT_READY`, `CORPUS_FAILED` (PR 2), mapped to `InvalidParams` / `InternalError`. `DaemonRpcError` and `errorResponse` gain an optional `data` merged next to `code` (`CORPUS_NOT_READY` carries `data.status`). The session's `DaemonConnection` surfaces `data` on `DaemonRpcError`.
- **Why**: brainstorm Q5; the session maps `CORPUS_NOT_READY` like its readiness gate without a second round trip.

### D10: `daemon.info` and `daemon status`

- **Choice**: `DaemonInfoResult.services` gains `vault: VaultInfo[]`, `VaultInfo = { vault, clients, idle_since?, profiles: [{ profile, state, indexed?, total?, notes?, last_reconcile?: { at, added, changed, removed, ms } }] }`. `daemon status` prints the existing daemon line, then one indented line per entry (`clients N`, or `idle since <time>`), then one per profile (state, `notes` or `indexed/total`, last reconcile counts and duration).
- **Why**: brainstorm Q13; the only operator view of shared state. `ProfileInfo` also carries `reason` while a profile is `unavailable`, which the status line prints.

### D11: One connection and one switch per process (PR 2)

- **Choice**: a `SharedServices` object (`src/modules/semantic/shared-services.ts`) owns the process's one `DaemonConnection` and the one-way switch `daemon | local`. `createEmbeddingProvider` and the corpus facade both take it; `DaemonEmbeddingProvider` delegates its fallback decision to it. Every facade runs `ensure()` through it: `DaemonUnavailableError` flips the switch for every facade and writes one stderr line; a `DaemonConnectionError` or a timeout fails that call only and the next call reconnects (respawning the daemon). Per connection epoch, the corpus facade re-sends `vault.attach` for each vault before its first call, as the embedding facade re-sends `embed.initialize`. At startup the server attaches every semantically enabled vault in the background, so in practice the switch is decided before the first tool call.
- **Why**: brainstorm Q6 and charting decision 1. A switch that flips mid-session only when the daemon cannot be located or started (for example an upgraded CLI script with the old daemon gone) keeps today's embedding behaviour and the existing "upgraded under an open session" scenario; a daemon that merely dies is reconnected, never replaced in-process.
- **Alternatives**: a switch per facade (embedding in-process while the corpus is in the daemon, or the reverse: two models or two corpora); never switching after startup (an upgraded install would lose semantic search until restart).

### D12: The session-side `SemanticBackend` (PR 2)

- **Choice**: `SemanticBackend = CorpusReader + { status(): Promise<BackendStatus>; dispose(): Promise<void> }`. Two implementations behind one factory: `DaemonSemanticBackend` (`vault.status`, `corpus.nearest`, `corpus.nearestBlocks` with 10 s / 30 s timeouts; a `vault.status` timeout reads as `unavailable`, "daemon did not answer", for that call; `CORPUS_NOT_READY` becomes a readiness error carrying the status) and `LocalSemanticBackend` (the process's in-process `VaultEntries`, attached once). `VaultRegistry` keeps building one per vault through `semanticBackendFactory`. `snapshot()` and `CorpusSnapshot` go; `SearchEngine` leaves the tools' deps.
- **Why**: brainstorm Q11; one interface both sides honour.

### D13: The semantic-leg composition over `CorpusReader` (PR 2)

- **Choice**: `executeRetrieval` takes `corpus: CorpusReader` and `allowed?: string[]` instead of `sources` + `searchEngine`. Per search: one `embed.query` per query; one `nearest` call with every query vector as an anchor (`threshold`, `limit + 1`, `allowed`); a second `nearest` at the fallback threshold for the queries that came back empty under a default threshold; one `nearestBlocks` with every query vector (`paths` = seeds; `quick`: threshold 0, limit 5; `deep`: threshold `similarity.deep`, limit `limit`); one backfill `nearestBlocks` per starved seed with every query vector (`paths: [seed]`, `limit: 1`, `threshold: 0`), keeping the best; one expansion `nearest` with `{ path: seed }` anchors (`exclude` = seeds, `limit` = per-seed limit, `threshold` = expansion floor, `allowed`). Merging, caps, `truncated`, `per_query_hits` and `per_query_fallback` are unchanged code. `runRetrievalPipeline` takes the backend instead of `snapshot` + `searchEngine`; `narrowSources` goes (the corpus applies `allowed`).
- **Why**: brainstorm Q11 and #164; `exclude` = seeds with the per-seed limit returns exactly what today's `limit + seeds` then filter returns.

### D14: `get_similar_notes` and `find_duplicates` (PR 2)

- **Choice**: `get_similar_notes` makes one `nearest` (`{ path }`, `threshold`, `exclude: [path]`, no limit); `null` → `NOT_FOUND`; forward links resolve through a basename index built from `entry.reader.scan()` (the vault-wide scoped list), so a short note counts as `forward_link`. `find_duplicates` sends `entry.reader.scan()` as `{ path }` anchors in batches of 64 with `threshold`, skips `null`, folds each pair to `note_a < note_b` by `localeCompare`, sorts as `compareDuplicatePairs` does today, then `filterExisting`.
- **Why**: brainstorm Q11; the session holds no vector to compare.

### D15: `index` and `eval`

- **Choice**: `neuro-vault-mcp index` keeps running in-process: `withReconcileLock` + `reconcileProfile` over `shardWriter(store)`. A daemon entry whose next pass waits on that lock refreshes afterwards (D5). `npm run eval` loads a `ShardCorpus` for the vault and runs the same `executeRetrieval` over it in-process.
- **Why**: brainstorm Q15 and charting decision 7.

### D16: PR 1 keeps the session on its current path

- **Choice**: PR 1 adds the vault entry, the `vault` service and `daemon status`, and refactors reconcile (D4) and the scope (D6). The session's `createOwnCorpusBackendFactory` keeps `createCorpusBackend` and `loadCorpusSnapshot`, now over `reconcileCorpus` + `shardWriter(store)`, and its watcher gains the scope-aware predicate. No session code attaches. PR 2 deletes `createCorpusBackend`, `loadCorpusSnapshot`, `CorpusSnapshot` and the session watcher together with the switch to the facade.
- **Why**: brainstorm Q14 (PR 1 dark, no transitional window).

### D17: ADR and concept docs

- **Choice**: propose **ADR-0020 "Per-vault state lives in the daemon's vault entry"**: the vault entry, attach without detach, idle per entry and corpus, one connection and one switch per process, and the end of ADR-0014's in-process per-vault watcher, which it supersedes in part. Written in PR 2, after the owner's ack. A new `docs/architecture/vault-entry.md` describes the vault entry (attach, idle, reconcile loop, watcher); `shared-daemon.md`, `own-corpus.md`, `semantic-backend.md`, `search-engine.md`, `vault-registry.md` and `vault-scope.md` are updated; `docs/guide/` is swept.
- **Why**: the design rule for a change to a prior ADR's core invariant (ADR-0014: "an in-process per-vault watcher") and the one-concept-one-file rule.

## Risks / Trade-offs

- [Risk] A daemon crash takes semantic search down in every session at once → Mitigation: each session reconnects (respawning the daemon) on its next call and re-attaches per epoch; the entry warm-loads from shards; lexical search is unaffected; `--no-shared` remains.
- [Risk] Ranking drift between the composed leg and today's in-memory leg → Mitigation: a parity test runs today's `executeRetrieval` (kept as a test oracle until PR 2 lands) and the new one over the same fixture corpus for both efforts, with and without `allowed`, and requires identical `RetrievalOutput`; `npm run eval` before and after.
- [Risk] Two "entry" types (`IVaultEntry` in the session, `VaultEntry` in the shared module) confuse readers → Mitigation: D1's naming, a sentence in `vault-entry.md` and `vault-registry.md`, and no import of `src/lib/vault-entry/` from tool code.
- [Risk] An `index` run that finishes while a daemon entry is idle leaves the entry's memory behind the shards → Mitigation: the entry's next pass compares notes against its in-memory metadata and re-embeds the notes `index` already did, which is correct but redundant work; a pass that waited on `index` refreshes first (D5). Accepted: `index` while a server runs is rare.
- [Trade-off] A search costs several socket round trips (query embeddings, seeds, blocks, backfill, expansion) → accepted (ADR-0019), with every query batched into one call per step.
- [Trade-off] `find_duplicates` does about twice the cosine work of the triangular loop → accepted for a rarely used tool.
- [Trade-off] Readers can see a pass half-applied (some notes re-embedded) → accepted (ADR-0019): each note is coherent and the identity never mixes.
- [Risk] chokidar's directory callback semantics differ by platform → Mitigation: the watcher test drives the real `ignored` predicate with a table of relative paths, including a Windows-style input (#106), and a chokidar integration test checks an excluded subtree is never walked.

## Migration Plan

1. **PR 1** (`Refs #158`, `Refs #175`): corpus interface, `ShardStore` rename, reconcile split, scope-aware watcher, vault entry and reconcile loop, `vault` service, per-connection context, error codes, `daemon.info` and `daemon status`. Sessions unchanged. Releasable as a minor; rollback is a revert.
2. **PR 2** (`Refs #158`, `Closes #175`, `Closes #106`): `SharedServices`, the session facade and local backend, `corpus` service, `executeRetrieval` and the two tools over `CorpusReader`, eager attach, removal of the session's watcher, reconcile and snapshot, `eval` over `ShardCorpus`, ADR-0020, docs sweep, verify, retrospective, archive. Minor release.
3. **Measurement** after PR 2, by hand, on the owner's vault, against the settled baseline on #158 (macOS footprint at +300 s).

Rollback after PR 2 is a revert, or `--no-shared` per client, which runs the same vault-entry module in-process. No on-disk migration in either direction: the shard format does not change.

## Open Questions

None blocking. ADR-0020 (D17) is proposed and waits for the owner's ack before it is written in PR 2.
