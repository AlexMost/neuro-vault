## Context

The decisions are in `brainstorm.md` (settled items 1–11, Q1–Q12, forks F1 and F2 settled by the owner on 2026-10-18), taken from the resolution of #165, the wire findings of #163 and what `daemon-vault-registry` built. This file turns them into a technical design and settles the implementation forks they left to the change: where the new code lives and what it is called, how the entry's cache refreshes under sharing, how a vault attaches once for two facades, how `--no-semantic` and `--no-shared` are served, and what pins ranking parity.

**Today, per session** (after #182, #183). `buildSearchNotesTool` (`src/modules/semantic/tools/search-notes.ts`) builds one `LexicalIndex` per vault name on first use and keeps it in a module-level `Map` for the tool's life. `LexicalIndex` (`src/lib/obsidian/lexical/lexical-index.ts`) is a `path → { mtimeMs, ParsedNote }` cache over the session's scoped `VaultReader`: `search()` scans, intersects `allowed`, drops every cached path outside that set, stats the rest, re-parses the changed ones, and ranks through `rankNotes` with the caller's `getBacklinkCount` (the session's `WikilinkGraphIndex`, `ensureFresh()`ed by the tool before the leg). `runRetrievalPipeline` (`retrieval-pipeline.ts`) takes `lexical: Pick<LexicalIndex, 'search'>` and `getBacklinkCount` and runs the lexical leg first, unconditionally; a throw from it propagates and the gate reports `INTERNAL_ERROR`. `eval/pipelines.ts` builds its own `LexicalIndex` and graph.

**Today, in the daemon** (ADR-0020). `src/lib/vault-entry/`: `IVaultEntry` (scope, one chokidar watcher started with the entry, one reconcile loop, a `ShardCorpus` per profile, `reader(profile)` with the scope folded in, `info()`), `VaultEntries` (`realpath → IVaultEntry`; `attach(connectionId, vault, profiles)` re-reads scope and the `semantic` key, accepts `profiles: []`, holds, idles per entry and per profile; `status()`, `reader()` and the private `attached(connectionId, vault, profile)` check the *pair*; `detach()`, `info()`). Services: `vault` (`attach`, `status`), `corpus` (`nearest`, `nearestBlocks`), `wired()` mapping `VaultEntryError` to the wire; `protocol.ts` closes every method's params with `onlyKeys`; `admin.ts` prints `vaultLine` / `profileLine`. Session side: `ISharedServices` (one connection, one switch), `createSemanticBackends` (`backend/index.ts`: the lazily built in-process `VaultEntries` under `LOCAL_CONNECTION_ID` 0, `createDaemonSemanticBackend` owning its vault's per-epoch `vault.attach`, `createLocalSemanticBackend`, `createDisabledSemanticBackend` for `"semantic": false`, which never attaches), and `server.ts` attaching every vault that has a backend in the background after `server.connect`.

**Constraints.** ADR-0018 (service + facade + in-process fallback; no new protocol, process or port). ADR-0020 (per-vault state belongs to the vault entry, reached through an attach on the process's one connection; no own connection, switch or detach). The hybrid-search contract: lexical ranking is deterministic and tiered, freshness "reflects the vault state at request time", `total_notes` is the vault's count independent of `filter`. `naming-conventions.md`: new interfaces take the `I` prefix. Owner decisions of 2026-10-18: `--no-semantic` stays in-process and daemon-free (F1); one PR (F2).

## Goals / Non-Goals

**Goals:**

- One lexical cache and one tie-break graph per vault directory per daemon, whatever the number of sessions; a daemon-served session parses no note for its lexical leg.
- `search_notes` ranks and renders byte-identically to today for the same disk state, in every mode and effort, with and without `filter`; `npm run eval` scores do not move.
- The lexical leg keeps its read-through freshness and existence safety under sharing, and never depends on the watcher or the reconcile loop.
- The same vault-entry module serves the daemon and the in-process fallback; `--no-semantic` keeps today's in-process path and starts no daemon.
- `daemon status` shows the cache per entry; the footprint is measured and posted on #158.

**Non-Goals:**

- The wikilink graph for any tool but the lexical tie-break (#172); a note-metadata index or `query_notes` in the daemon.
- Watcher-driven invalidation or an FTS-backed lexical implementation (both fit behind `lexical.search` later).
- A lexical readiness state on the wire; a second PR; a measurement script in the repo.

## Decisions

### D1: The lexical cache and its graph are members of `IVaultEntry`

- **Choice**: `createVaultEntry` builds, with the entry, one `LexicalIndex` and one `WikilinkGraphIndex`, both over the entry's scoped `FsVaultReader` (the reader `fsDepsFor(scope)` already builds; `setScope` rebuilds both over the new reader and the graph's build time is reset so its next `ensureFresh()` rebuilds). `IVaultEntry` gains:

  ```ts
  lexicalSearch(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
  lexicalInfo(): ILexicalInfo;
  ```

  where `lexicalSearch` awaits `graph.ensureFresh()`, then `lexical.search({ ...opts, getBacklinkCount: (p) => graph.getBacklinkCount(p) })`. `IVaultInfo` gains `lexical: ILexicalInfo = { state: 'warming' | 'ready'; notes?: number; last_refresh?: { at: string; parsed: number; ms: number } }`. Neither member has an idle timer: both go with the entry (`dispose()`), and an entry a connection attached with `profiles: []` keeps them.
- **Why**: brainstorm Q1 and settled item 6; the GLOSSARY already names the lexical cache a member of the vault entry.
- **Alternatives**: a separate `LexicalEntries` registry keyed by realpath (a second lifecycle and a second attach for the same directory, against ADR-0020's constraint); injecting a backlink-count port into the entry so the fallback could reuse the session's graph (the fallback would then differ from the daemon in who owns the graph's freshness; the duplicate is ~0.7 MB, brainstorm Q7).

### D2: `LexicalIndex` refreshes serialised, over the whole scope, and never evicts on `allowed`

- **Choice**: `LexicalIndex` (file unchanged) changes its refresh rule, for every owner (entry and standalone alike):
  - `search()` calls `refresh()` with no path argument; `refresh()` scans the current scope (`reader.scan()`), drops cached paths the scan no longer lists, stats every scanned path and re-parses the changed ones. `allowed` is applied after the refresh, to the candidate map handed to `rankNotes`, so a filtered call evicts nothing. `totalNotes` stays `scan().length`.
  - Refreshes never overlap. `refresh()` keeps `running: Promise<void> | null` and `queued: Promise<void> | null`: a caller that finds nothing running starts a refresh; a caller that finds one running awaits it and then shares one follow-up refresh with every other caller that arrived during the same run. So a caller is never served by a refresh that began before it arrived, and a burst costs at most two refreshes.
  - New `warm(): Promise<void>` runs one refresh (through the same rule) and never rejects: a failure is reported through the owner's `warn` and the next `search()` refreshes again. New `info(): { warmed: boolean; notes: number; lastRefresh?: { at: Date; parsed: number; ms: number } }`.
- **Why**: settled items 4 and 5 and brainstorm Q3; the hybrid-search requirement "reflects the vault state at request time" must stay literally true when several sessions share one cache.
- **Alternatives**: a caller joining the refresh in flight (a call could be served by a scan that began before it; cheaper by one refresh per burst, but a weaker promise than today's); a per-call refresh under a mutex (serialises N callers into N refreshes).

### D3: The entry's watcher runs only while it has an enabled profile

- **Choice**: `createVaultEntry` starts its watcher when the first profile with a corpus is attached (`attachCorpus`) and closes it when the last one leaves (`detachCorpus`, `setSemantic(false)`, `removeProfile`); `setScope` and `onVaultRestored` restart it only when it is running. An entry attached with `profiles: []`, or whose vault sets `"semantic": false`, therefore has scope, loop (never taking the lock) and lexical members, and no watcher. `IVaultEntry.requestPass()` on such an entry is a no-op pass as today.
- **Why**: the lexical cache is read-through and never consumes watcher events (settled item 4), so a watcher on an entry without a corpus would hold ~1,000 handles per vault for nothing; and `semantic-backend-lifecycle` promises that a vault with `"semantic": false` "SHALL NOT be watched", which such a vault now attaching must keep true.
- **Alternatives**: keep the watcher always on (change 1's "scope, watcher and a loop with nothing to reconcile" for `profiles: []`; wasteful once opted-out vaults attach routinely).

### D4: `VaultEntries.lexical()` and the entry-level attach check

- **Choice**: `VaultEntries` gains `lexical(connectionId, vault): Pick<IVaultEntry, 'lexicalSearch'>`, which checks that *this connection attached the vault* (its id is in the entry's client set, whatever profiles it named) and throws `VaultEntryError('NOT_ATTACHED', …)` otherwise; the existing pair-level check stays for `status()` and `reader()`. `attach()` is unchanged in shape; creating an entry calls `lexical.warm()` in the background (D2), and `setScope` warms again.
- **Why**: brainstorm Q1; `lexical.search` carries no profile.

### D5: The `lexical` service and `LEXICAL_FAILED`

- **Choice**: `src/daemon/services/lexical.ts`, `createLexicalService(entries: Pick<VaultEntries, 'lexical'>): ServiceHandlers` with one method `search`. Params `{ vault: string; queries: string[]; allowed?: string[]; note_cap: number; per_note_cap: number }`, closed with `onlyKeys`; `queries` a non-empty array of strings, the caps positive integers (`INVALID_PARAMS` otherwise). Order: shape → `entries.lexical(ctx.id, vault)` through `wired()` (`NOT_ATTACHED`) → `lexicalSearch` → a throw is `LEXICAL_FAILED` with the reason. Result `LexicalSearchResult = { notes: Array<{ path; matches: LexicalMatch[]; matched_queries: string[] }>; truncated; per_query_counts; per_query_token_counts; total_notes }` (`protocol.ts`, beside the `Corpus*` types). `DaemonErrorCode` gains `LEXICAL_FAILED` → `ErrorCode.InternalError`. `lexical.*` calls make the connection a client (the socket server's existing rule for any non-`daemon.` namespace). Registered in `startServing` beside `vault` and `corpus`. 30 s on the session side; no deadline in the daemon.
- **Why**: settled items 1–3, brainstorm Q2, Q5.
- **Alternatives**: a `profile` param (rejected in #165: the cache is per entry); a `lexical.warm` method (the attach already warms).

### D6: `ILexicalReader` in the session, three implementations, one factory

- **Choice**: `src/lib/obsidian/lexical/reader.ts` declares the interface the session depends on:

  ```ts
  export interface ILexicalSearchOptions {
    queries: string[];
    allowed?: ReadonlySet<string>;
    noteCap: number;
    perNoteCap: number;
  }
  export interface ILexicalResult {
    notes: RankedNote[];
    truncated: boolean;
    perQueryCounts: Record<string, number>;
    perQueryTokenCounts: Record<string, Record<string, number>>;
    totalNotes: number;
  }
  export interface ILexicalReader {
    search(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
    /** Starts whatever makes the first search fast; never rejects. */
    warm(): Promise<void>;
  }
  export class LexicalSearchError extends Error {} // carries `cause`; search_notes maps it
  ```

  `src/modules/semantic/lexical/` holds the three implementations and their factory:
  - `createDaemonLexicalReader({ services, attachment, vaultRoot, local })`: `search` runs `services.ensure()`; `local` → delegates to the in-process reader (built once); else `attachment.key()` then `lexical.search` (30 s) and maps `matched_queries` → `matchedQueries`. `warm()` is `attachment.key()` swallowed. Errors: `LEXICAL_FAILED`, `DaemonTimeoutError`, `DaemonConnectionError`, `VAULT_UNAVAILABLE` (from the attach) → `LexicalSearchError` with the reason; `NOT_ATTACHED` → `attachment.forget()` then `LexicalSearchError`. Nothing here touches the switch.
  - `createLocalLexicalReader({ entries, attachment })`: `attachment.key()` (the local attachment, D7) then `entries.lexical(LOCAL_CONNECTION_ID, key).lexicalSearch(opts)`; a `VaultEntryError` → `LexicalSearchError`.
  - `createStandaloneLexicalReader({ vaultRoot, reader, graph })`: today's path — a `LexicalIndex` over the session's reader, `graph.ensureFresh()` then `search` with `graph.getBacklinkCount`. `warm()` is a no-op: a `--no-semantic` session builds its cache on first search, as today, so the `--no-semantic` floor does not move. `eval/pipelines.ts` uses it.
  - `RetrievalPipelineDeps` becomes `{ corpus?; lexical: ILexicalReader; filterExisting; embeddingProvider; similarity }`; `getBacklinkCount` leaves it. `IRegisteredVault.lexical: ILexicalReader`, built by `IRegisteredVaultDeps.lexicalReaderFactory({ vaultRoot, vaultName, reader, graph, enabled })`. `buildSearchNotesTool` drops its `Map` and reads `entry.lexical`; `runSearchForEntry` catches `LexicalSearchError` from the pipeline and throws `DEPENDENCY_ERROR` (`wrapDependencyError`, message "Lexical search failed", `details: { vault, operation: 'search_notes' }`).
- **Why**: settled item 7, brainstorm Q6, F1; `search_notes` keeps one shape whichever process serves the leg.
- **Alternatives**: the reader on the tool instead of the registry entry (two tool builders, `buildSemanticTools` and `buildLexicalOnlyTools`, would each need the factory); mapping errors to `ToolHandlerError` inside the readers (ties a lib-level interface to the tool layer).

### D7: One attachment per vault, shared by both facades

- **Choice**: `src/modules/semantic/backend/attachment.ts`:

  ```ts
  export interface IVaultAttachment {
    /** The realpath key on the current connection epoch; attaches first when needed. */
    key(): Promise<string>;
    /** Forget the attach (NOT_ATTACHED): the next key() attaches again. */
    forget(): void;
    /** The last attach's status for this session's profile, if it named one. */
    readonly profile: string | undefined;
  }
  ```

  `createDaemonAttachment({ services, vaultRoot, profiles })` carries over `createDaemonSemanticBackend`'s per-epoch, single-flight `vault.attach` (the answer records the key only if the epoch is still current; `VAULT_UNAVAILABLE` rejects as-is); `createLocalAttachment({ entries, connectionId, vaultRoot, profiles })` does the same over `VaultEntries.attach`. `profiles` is `[profile]` for a semantically enabled vault and `[]` for one with `"semantic": false`. `createDaemonSemanticBackend` and `createLocalSemanticBackend` take the attachment instead of owning the attach; their `status()` rules (`ATTACHING` while the attach is in flight, `unavailable` on failure) read the attachment's in-flight state through it. `createDisabledSemanticBackend` is unchanged.
- **Why**: brainstorm Q8; two facades on one vault must share one attach per epoch, and an opted-out vault must attach for its lexical leg without a semantic backend doing it.
- **Alternatives**: the lexical reader attaching on its own (two attaches per vault per epoch; harmless to the daemon but a second place to get the epoch rule wrong).

### D8: `createSemanticBackends` becomes `createVaultClients`

- **Choice**: `src/modules/semantic/backend/index.ts` exports `createVaultClients(opts)` returning `{ semanticBackendFactory, lexicalReaderFactory, dispose }`. It owns the lazily built in-process `VaultEntries` (unchanged: `idleTimeoutMs: 0`, the session's embedder for its one profile) and one attachment per vault root (daemon or local by `shared`), built on the first factory call for that root. `server.ts` builds it only when `config.semantic.enabled`; under `--no-semantic` the registry gets no backends and `lexicalReaderFactory = standalone`, and no `ISharedServices.ensure()` is ever called (F1). The startup loop attaches every registered vault in the background: `void entry.backend?.status()` as today for vaults with a backend, and `void entry.lexical.warm()` for every vault, which for a daemon or local reader is the attach and for the standalone reader nothing.
- **Why**: brainstorm Q6, Q8; one owner for the process's vault-side clients.

### D9: `daemon.info` and `daemon status`

- **Choice**: `IVaultInfo.lexical` (D1) is printed by `admin.ts` as one indented line under the vault line and before the profile lines: `lexical  warming`, or `lexical  ready  <n> notes  last refresh <iso> ~<parsed> parsed <ms> ms`. A daemon answering without `lexical` prints no such line.
- **Why**: settled item 9, brainstorm Q9.

### D10: Parity is pinned against a frozen copy of today's index

- **Choice**: `test/lib/obsidian/lexical/_legacy-lexical-index.ts` is a frozen copy of today's `lexical-index.ts` (imports pointed at `src/`), the oracle `test/semantic/lexical/parity.test.ts` runs against: over one fixture vault on disk and the query sets of #177, the standalone reader, the local reader (in-process `VaultEntries`) and the daemon reader (an in-test `startDaemonServer` with the `vault` and `lexical` services) each produce an `ILexicalResult` deep-equal to the oracle's, with and without `allowed`, and `search_notes` through `test/_gate.ts` produces one payload whichever reader the registry entry holds. The oracle stays, as `_legacy-retrieval.ts` did.
- **Why**: #176's acceptance ("identical to in-process ranking"); the one place behaviour could drift is the refresh rule, and the oracle sees it.

### D11: Measurement and what it must record

- **Choice**: by hand on the owner's vault after the PR, the baseline method of #158: N ∈ {1, 3, 5} sessions driven through `initialize` and `search_notes` to `ready`, macOS physical footprint at +15, +60, +120 and +300 s, sessions and daemon, each run reported (no means only), one daemon run sampled to +900 s; `--no-semantic` floor re-measured once on the same build. Posted on #158 next to the change 1 numbers with the effort's percentage against the settled baseline table. Expected: a daemon-served session falls from ~97 MB toward the ~62 MB floor by about the cache's heap for that vault; the daemon grows by one cache per attached vault; the startup peak is recorded either way.
- **Why**: settled item 11; the change 1 retrospective (report per run, sample past +300 s, derive the expected saving from named allocations).

### D12: Docs; no ADR, no glossary term

- **Choice**: `docs/architecture/lexical-search.md` becomes the one file for the lexical leg's new shape (the cache as an entry member, D2's refresh rule, never-evict, the entry's graph, `ILexicalReader` and its three implementations, error mapping); `vault-entry.md` (members, warm, D3's watcher rule, the "what it deliberately does not do" list), `shared-daemon.md` (the `lexical` service, the protocol row, `LEXICAL_FAILED`, the status line, the "how a new service attaches" section), `semantic-backend.md` (the attachment; an opted-out vault attaches), `vault-registry.md` (`lexical`), `module-structure.md`, `mcp-server-shape.md`, `retrieval-policy.md`, `docs/architecture/README.md`, `docs/guide/installation.md` and `configuration.md` and `README.md` (when the daemon starts: a shared session starts it for any registered vault, `"semantic": false` included; not under `--no-semantic` or `--no-shared`). No new ADR: ADR-0020 states the cache is the next vault-entry member reached through the same attach, and no invariant of a prior ADR changes. No glossary term (settled item 10).
- **Why**: the one-concept-one-file rule and the design rule for ADRs.

## Risks / Trade-offs

- [Risk] A daemon that is slow or gone makes `search_notes` fail where today's lexical leg never did → Mitigation: the 30 s timeout fails only that call; a dropped connection reconnects (respawning the daemon) on the next call; `--no-shared` keeps the leg in-process; never a fallback flip (#165, ADR-0020). Accepted by the owner in #165.
- [Risk] Ranking or rendering drift from the refresh change → Mitigation: D10's oracle over the #177 query sets, through three readers and the tool gate; `npm run eval` before and after.
- [Risk] Serialised refreshes add latency under concurrent sessions → Mitigation: at most two refreshes per burst, each a scan plus one `stat` per note (tens of milliseconds for ~1,000 notes); parse cost is paid only for changed notes. A test with a barrier on `stat` pins "served by a refresh that began after the call".
- [Risk] The daemon warms a cache for every attached vault, searched or not → accepted: that is the one copy the change exists to hold; the measurement records the daemon per run.
- [Risk] Two facades disagree about the attach after a daemon respawn → Mitigation: one attachment per vault (D7), forgotten by whichever facade sees `NOT_ATTACHED`, and a test where a respawned server sees one `vault.attach` followed by both a `corpus.*` and a `lexical.search` call.
- [Trade-off] `--no-shared` holds two wikilink graphs per vault (~0.7 MB each) → accepted (brainstorm Q7); #172 removes it.
- [Trade-off] A lexical failure is now `DEPENDENCY_ERROR`, not `INTERNAL_ERROR` → the code's meaning; noted in the proposal and the guide's error table.
- [Trade-off] An opted-out vault's entry has no watcher, so a scope change still takes effect only on the next attach → unchanged from change 1 for every entry.

## Migration Plan

1. **One PR** (`Refs #158`, `Closes #176`): the entry members and lazy watcher, the `lexical` service, the session readers and attachment, the registry and tool wiring, `daemon status`, the docs sweep, verify, retrospective, archive. Minor release; no tool contract change; no on-disk format change.
2. **Rollback** is a revert, or `--no-shared` per client (the leg runs in the in-process entry), or `--no-semantic` (today's path exactly).
3. **Measurement** after the PR merges, by hand (D11), posted on #158; the issue's end-of-effort percentage follows.

## Open Questions

None. F1 and F2 were settled by the owner on 2026-10-18 (brainstorm).
