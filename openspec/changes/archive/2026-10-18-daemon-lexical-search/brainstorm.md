# Brainstorm — daemon-lexical-search (#176)

Raw decision log. Path: **architectural** (a new daemon service, a new member of the vault entry, a new seam between `search_notes` and its lexical leg, and the end of the per-session lexical cache for sessions the daemon serves).

Change 2 of the effort epic #158, after `daemon-vault-registry` (#175, archived 2026-10-18 as `openspec/changes/archive/2026-10-18-daemon-vault-registry/`). Every decision below was made on wayfinder map #160 and its tickets, in conversation with the owner, on 2026-10-15/16: the `lexical.search` contract and the freshness rule in the resolution of #165, the wire findings of #163, and the "Deferred to change 2" section of change 1's brainstorm. This log collects them in the order this change needs them and adds what change 1 built since. No interactive round was run for the decided items; the two forks the sources did not cover were put to the owner and settled on 2026-10-18 (F1, F2 at the end).

## Background

- **Today, per session.** `buildSearchNotesTool` (`src/modules/semantic/tools/search-notes.ts`) keeps a module-level `Map<vault name, LexicalIndex>`; `LexicalIndex` (`src/lib/obsidian/lexical/lexical-index.ts`) is a read-through cache `path → { mtimeMs, ParsedNote }` over the session's scoped `VaultReader`: every `search()` scans the scope, intersects `allowed` when a `filter` was given, stats every scoped file, re-parses the changed ones, **evicts every path outside the scoped set** (so a filtered call evicts the rest of the vault), ranks through `rankNotes` with the session's `WikilinkGraphIndex.getBacklinkCount` as the tie-break, and reports `totalNotes = scan().length` before `allowed`. `runRetrievalPipeline` (`retrieval-pipeline.ts`) takes `lexical: Pick<LexicalIndex, 'search'>` and `getBacklinkCount` and always runs the lexical leg first: it is what a semantic failure degrades to. `npm run eval` builds its own `LexicalIndex` + graph (`eval/pipelines.ts`).
- **Since #177** (merged, #171): a cached unit is `raw` + `norm` + lines/heading; the per-character offset map is rebuilt per snippet and snippets are built only for matches that survive the caps. Cache heap on a 1,000-note synthetic vault went 146.6 MB → 46.8 MB (−68%); on the repo's own 387 files ~19 MB. That is the copy this change moves: one per vault instead of one per session.
- **Since #179** (merged, #150): `--no-semantic` keeps `search_notes` registered through `createLexicalOnlyTools`, lexical-only, `semantic_status: { state: "disabled" }`. No vault has a backend then and nothing in such a session touches the daemon.
- **Since change 1** (ADR-0020, `docs/architecture/vault-entry.md`, `shared-daemon.md`): the daemon keeps one **vault entry** per vault realpath (`src/lib/vault-entry/`: `IVaultEntry`, `VaultEntries`), served by the `vault` and `corpus` services; `vault.attach { vault, profiles }` accepts `profiles: []` for exactly this change ("attaches the vault alone: scope, watcher and a loop with nothing to reconcile, no corpus"); a closed connection is the only detach; an entry idles out by `--idle-timeout`; the scope is re-read on every attach and the entry's own scoped `FsVaultReader` (`fsDepsFor(scope)`) feeds its scan. On the session side `ISharedServices` holds the process's one `DaemonConnection` and one one-way switch; `createSemanticBackends` builds per vault a `createDaemonSemanticBackend` (attach per connection epoch, `vault.status`, `corpus.*`, delegation to a local backend once the switch is `local`) or a `createLocalSemanticBackend` over the process's lazily built in-process `VaultEntries` (`--no-shared`); a vault with `"semantic": false` gets `createDisabledSemanticBackend`, which never attaches. The server attaches every semantically enabled vault in the background at startup. Handlers take `(params, ctx: IConnectionContext)`; every method's params are closed with `onlyKeys`; `DaemonRpcError` carries optional `data`; `daemon.info.services.vault` is `IVaultInfo[]` and `daemon status` prints a vault line and profile lines.
- **Measured** (#158): after change 1 a session settles at ~97 MB (N = 5 mean, +300 s footprint) against the ~62 MB `--no-semantic` floor; the retrospective names the lexical cache as the next candidate for that ~35 MB gap and the suspected cause of the unchanged ~430 MB startup peak. The daemon settled at 246 MB in one run and 368/384 MB in two others, unexplained; one run sampled to +900 s stayed flat from +300 s.
- **Standing constraints.** ADR-0018: a shared capability is a namespaced service + a session-side facade over an interface the session already depends on + an in-process fallback; no new protocol, process or port. ADR-0020: per-vault state that can be shared belongs to the vault entry, reached through an attach on the process's one connection; no own connection, own switch or detach call. Owner preferences: incremental delivery, storage-agnostic interfaces (a later FTS-backed lexical implementation must fit behind the same method), manual measurement, careful plan authoring.

## Settled on the map (2026-10-15/16, not revisited)

From the resolution of #165, the wire findings of #163 and change 1's "Deferred to change 2":

1. **One method, `lexical.search { vault, queries, allowed?, note_cap, per_note_cap }`**, no `profile`: the cache is per vault entry, not per corpus. Result: today's `RankedNote` evidence in snake_case (`notes: [{ path, matches: [{ matched_in, snippet, lines?, heading? }], matched_queries }]`), `truncated`, `per_query_counts`, `per_query_token_counts`, `total_notes`; snippets are built in the daemon so fusion and MCP shaping need no second disk read. 30 s timeout.
2. **No not-ready state.** The lexical leg is what a semantic failure degrades to. The entry warms the cache in the background on attach; a call on a cold cache waits for the warm.
3. **`LEXICAL_FAILED`** (the implementation threw) → `DEPENDENCY_ERROR` in the session. A timeout or a dropped connection fails the call and with it `search_notes`, as a lexical failure does today; never a switch to the fallback.
4. **Freshness is read-through, as today**: every call scans the entry's scope, stats each file and re-parses the changed ones; concurrent calls on one entry share one refresh. The watcher and the reconcile loop do not touch the cache, so the leg is served during a pass and stays existence-safe (no `filterExisting` on lexical hits). The contract promises only "reflects the disk at call time"; watcher-driven invalidation or an FTS-backed implementation can replace the mechanism behind the same method.
5. **One cache per vault entry over the whole scope.** The entry applies its scope and intersects `allowed` (sent only when the search has a `filter`); `allowed` narrows ranking and **never evicts** (today's `refresh` evicts out-of-`allowed` paths, which would thrash a shared cache). `total_notes` = notes in the entry's scope before `allowed` (`N` for adaptive `k`).
6. **The backlink tie-break stays**: the vault entry keeps its own lazily rebuilt wikilink graph (TTL, as `WikilinkGraphIndex` today; ~0.7 MB per 1,200 notes), used only by lexical ranking, so the order is unchanged. The session keeps its graph for every other tool; moving the graph is #172, outside this effort.
7. **Session side: a `LexicalReader` facade** with a daemon implementation and an in-process one over `LexicalIndex` (`--no-shared`, `npm run eval`); `RetrievalPipelineDeps.lexical` becomes a `LexicalReader`; `getBacklinkCount` leaves the lexical call.
8. **The wire needs no new framing** (#163): `allowed` for 1,000 notes is 44–69 KiB, a lexical leg result at `deep` 5.6–8.7 KiB, both below the `embed.documents` batches already on the socket. `allowed` goes once per request as a JSON array; results serialise as the in-process types.
9. **`daemon status` gains the lexical cache line** (#176, change 1 Q13).
10. **No new glossary term**: `GLOSSARY.md` already defines the lexical leg and names the lexical cache as a member of the vault entry; the cache is an implementation detail of the leg. Checked against `GLOSSARY.md` on 2026-10-18; the domain-modeling skill is not needed.
11. **Measurement** by hand on the owner's vault, the same method as the baseline and the change 1 runs on #158 (N stdio sessions, macOS physical footprint at +300 s), posted on #158 next to the PR 2 numbers: sessions ~97 MB settled at N = 5, floor ~62 MB. No script in the repo, no CI gate. This closes the effort's percentage.

## Decision chain

### Q1. What exactly becomes a member of the vault entry?

Two things, both created with the entry and dropped with it:

- **The lexical cache**: one `LexicalIndex` over the entry's scoped reader (the same `FsVaultReader` that feeds the reconcile scan, rebuilt by `setScope`), with its freshness rule changed as Q3 says. It is the GLOSSARY's "lexical cache" of the vault entry.
- **The entry's wikilink graph**: one `WikilinkGraphIndex` over the same reader, lazy + 3-minute TTL exactly as the session's, consulted only by `rankNotes`' tie-break. The entry calls `ensureFresh()` before each ranking, as `search_notes` does today before its leg.

Neither has an idle timer of its own: an entry kept alive by a connection that attached it with `profiles: []` holds them, and the entry's timer frees them with everything else (change 1 Q3, D8). An entry whose vault has `"semantic": false` holds them too; that is why `profiles: []` exists.

`IVaultEntry` gains `lexicalSearch(opts)` and `lexicalInfo()`; `VaultEntries` gains `lexical(connectionId, vault)`, which checks that *this connection attached the vault* (any profile set, including none) and returns the reader — an entry-level check beside today's pair-level `attached(connectionId, vault, profile)`.

### Q2. `lexical.search` on the wire

| Method | Params | Result | Timeout |
|---|---|---|---|
| `lexical.search` | `vault` (realpath key from `vault.attach`), `queries: string[]` (non-empty), `allowed?: string[]`, `note_cap`, `per_note_cap` (positive integers) | `{ notes: [{ path, matches: [{ matched_in, snippet, lines?, heading? }], matched_queries: string[] }], truncated, per_query_counts: { [query]: number }, per_query_token_counts: { [query]: { [token]: number } }, total_notes }` | 30 s |

- Params are closed (`onlyKeys`), as every daemon method's are. The checks run in order: shape (`INVALID_PARAMS`), the connection attached the vault (`NOT_ATTACHED`), then the search; a throw inside the search is `LEXICAL_FAILED` (JSON-RPC `-32603`, like `CORPUS_FAILED`) with the reason. `DaemonErrorCode` gains `LEXICAL_FAILED` only.
- The query strings arrive as the session normalised them (`normalizeQuery` / `normalizeQueryArray` run in the tool); the daemon does not re-validate blank queries beyond "a string". Ranking, matching, normalisation and snippets are the existing `rankNotes` / `matchUnit` / `makeSnippet`, unchanged, so the result is byte-identical to today's in-process leg for the same disk state.
- `matched_queries` is the only camelCase → snake_case rename on the wire (`RankedNote.matchedQueries` in-process); the facade maps it back, and `search_notes`' output is unchanged.
- `lexical.*` calls make the connection a client, as `vault.*` and `embed.*` do.

### Q3. Freshness: read-through, serialised per entry, one refresh per burst

Today each call runs its own `refresh` after it arrives. In the entry, calls share the cache, so:

- Refreshes of one entry **never overlap**. A call that arrives while no refresh runs starts one; a call that arrives while one runs **waits for it and is served by the next one**, which all such waiters share. So a refresh that began before a call arrived never serves it, and a burst costs at most two refreshes, each a scan, one `stat` per scoped note and a parse of the changed ones. This keeps the hybrid-search contract's "reflects the vault state at request time" literally true under sharing, at a cost of some milliseconds per call.
- A refresh walks the **whole scope** (`reader.scan()` of the entry's current scope): it drops cached paths the scan no longer lists (deleted, or excluded by a scope change) and re-parses the changed ones. `allowed` is applied to the ranking's candidate set only, after the refresh, so a filtered call never evicts (settled item 5).
- **Warm on attach**: the entry starts a refresh when it is created and after every `setScope`; a `lexical.search` that arrives meanwhile follows the rule above (it waits for the warm, then one refresh serves it). There is no `warming` on the wire; `daemon status` shows it (Q9).
- **The watcher and the reconcile loop do not touch the cache** (settled item 4), so the lexical leg is served through a pass and across a watcher failure, and a lexical hit is existence-safe by construction, as today.
- A scope change through `setScope` rescopes the reader, so the next refresh drops the newly excluded notes; the graph is rebuilt over the new scope on its next TTL expiry or at once (`setScope` resets its build time). This is the same "next attach decides" rule as the corpus (change 1 Q2).

### Q4. Scope and `allowed`

The entry's scope is the vault's own (`.gitignore` + `config.json`, re-read on attach). The session computes `allowed` under its own startup scope, which can differ from the entry's until the session restarts (ADR-0020's accepted consequence); the entry **intersects** `allowed` with its scoped candidate set, so a path the entry excludes never ranks and a path only the session excludes is simply absent from `allowed`. `total_notes` is the entry's scoped count before `allowed`, so adaptive `k` does not shrink under a `filter`, as today.

### Q5. Errors, timeouts and the fan-out

| On the wire | In the session | `search_notes` |
|---|---|---|
| `LEXICAL_FAILED` | `DEPENDENCY_ERROR` with the reason | the call fails (nothing to degrade to) |
| `NOT_ATTACHED` | the facade forgets the attach and fails this call with `DEPENDENCY_ERROR`; the next call attaches again (as the corpus facade does) | the call fails |
| `DaemonTimeoutError` (30 s), `DaemonConnectionError` | `DEPENDENCY_ERROR` naming the daemon; the connection stays up on a timeout and reconnects on the next call after a drop (change 1 D11) | the call fails |
| `VAULT_UNAVAILABLE` on the attach | `DEPENDENCY_ERROR` with the daemon's reason; attached again on the next call | the call fails |

Today a lexical throw surfaces as `INTERNAL_ERROR` (no `ToolHandlerError` in the path); it becomes `DEPENDENCY_ERROR`, which is the code's meaning. In multi-vault fan-out a lexical failure is a per-vault error entry, not a fatal one. Nothing here flips the process's switch: only locating or starting the daemon does (ADR-0020).

### Q6. The session side: `ILexicalReader`, where it lives, who builds it

- `ILexicalReader { search(opts: { queries: string[]; allowed?: Set<string>; noteCap: number; perNoteCap: number }): Promise<ILexicalResult> }`, `ILexicalResult = { notes: RankedNote[]; truncated; perQueryCounts; perQueryTokenCounts; totalNotes }` — today's `LexicalIndex.search` minus `getBacklinkCount`, which the reader resolves itself (the entry's graph in the daemon and in the in-process entry; the session's graph in the standalone reader, Q7).
- `IRegisteredVault` gains `lexical: ILexicalReader`, built per vault by a `lexicalReaderFactory` in `IRegisteredVaultDeps`, symmetric with `semanticBackendFactory`. `buildSearchNotesTool` drops its own `Map` of `LexicalIndex`es and reads `entry.lexical`; `createLexicalOnlyTools` needs nothing extra. `RetrievalPipelineDeps` becomes `{ corpus?, lexical: ILexicalReader, filterExisting, embeddingProvider, similarity }`; `getBacklinkCount` leaves it, and `search_notes` keeps `entry.graph.getBacklinkCount` for the response's `backlink_count` field only.
- **Three implementations**, one factory:
  - `createDaemonLexicalReader`: over the process's `ISharedServices` and the vault's attachment (Q8); `lexical.search` with the 30 s timeout; maps the result to `ILexicalResult`; once the switch is `local`, delegates to the in-process reader for the same vault, built once, as the semantic facade does.
  - `createLocalLexicalReader`: over the process's in-process `VaultEntries` (`entries.lexical(LOCAL_CONNECTION_ID, key)`), attached through the same local attachment the local semantic backend uses. The same `src/lib/vault-entry/` module runs in the daemon and here, so the two cannot drift (ADR-0020).
  - `createStandaloneLexicalReader`: today's code path, a `LexicalIndex` over the session's reader with the session's graph for the tie-break. Used by `npm run eval` (settled item 7: eval measures ranking, not transport) and by `--no-semantic` sessions (F1: such a session builds no vault clients and starts no daemon).
- `createSemanticBackends` generalises to **`createVaultClients`** (`src/modules/semantic/backend/index.ts` → the process's vault-side clients): it owns the one lazily built in-process `VaultEntries`, one attachment per vault, and hands the registry both factories; `dispose()` is unchanged in meaning.

### Q7. The in-process fallback holds two graphs; accepted

Under `--no-shared`, or after the switch flipped, the process holds the session's `WikilinkGraphIndex` (every other tool) and the in-process entry's (lexical tie-break): the same class, the same TTL, ~0.7 MB each for ~1,200 notes. Injecting the session's graph into the entry would make the fallback differ from the daemon in who owns freshness; the duplicate is cheaper than the seam, and #172 removes it when the graph moves. Recorded as a trade-off in design.

### Q8. One attachment per vault, shared by both facades

Today `createDaemonSemanticBackend` owns `vault.attach` for its vault and a `"semantic": false` vault never attaches. With the lexical leg in the entry, **every registered vault attaches**: with `[profile]` when it is semantically enabled, with `[]` when it opted out. The attach moves out of the semantic facade into a per-vault **`IVaultAttachment`** (`key(): Promise<string>`: the realpath on the current connection epoch, single-flight, re-sent per epoch, forgotten on `NOT_ATTACHED`, `VAULT_UNAVAILABLE` surfaced to the caller), used by the daemon semantic backend and the daemon lexical reader alike; the local side has the same object over `VaultEntries.attach(LOCAL_CONNECTION_ID, …)`. The startup attach (`server.ts`) covers every vault, not only the semantically enabled ones: for a `"semantic": false` vault its first `lexical` touch, or an explicit `attachment.key()`, is the background attach. `createDisabledSemanticBackend` stays as it is: `status()` is `disabled`, reads refuse; it simply no longer decides whether the vault attaches.

Consequence for the docs: README and `docs/guide/installation.md` say the daemon starts "when semantic search is on and shared (not under `--no-semantic`, `--no-shared`, or with every vault set to `"semantic": false`)". After this change a session with shared services on attaches a `"semantic": false` vault for its lexical leg, so the daemon starts for it; that sentence changes. `--no-semantic` still starts no daemon (F1).

### Q9. `daemon.info` and `daemon status`

`IVaultInfo` gains `lexical: { state: 'warming' | 'ready'; notes?: number; last_refresh?: { at: string; parsed: number; ms: number } }` — `notes` is the number of cached notes once warm, `last_refresh` the last refresh's time, how many notes it re-parsed and how long it took. `daemon status` prints one indented line under the vault line and before the profile lines:

```
  vault /vaults/notes  clients 2
    lexical  ready  955 notes  last refresh 2026-10-18T09:00:00.000Z ~3 parsed 41 ms
    harrier-270m  ready  955 notes  last reconcile 2026-10-18T09:00:00.000Z +1 ~0 -0 340 ms
```

A daemon of another build may answer without `lexical`; `status` prints what it recognises, as it does for `vault` today.

### Q10. What the session no longer holds

A session the daemon serves holds no `LexicalIndex` and parses no note for its lexical leg; its per-vault lexical memory is the facade. The `Map<vault name, LexicalIndex>` in `buildSearchNotesTool` goes. A `--no-shared` session holds the cache inside its in-process entry, once per vault, as before in effect. The startup peak is expected to drop for daemon-served sessions (the lexical parse was the suspect); the measurement records it either way.

### Q11. Tests that pin parity

- **Leg parity**: for a fixture vault on disk and the query sets of #177 (phrase, multi-token, accent-folded, apostrophe, multi-query, no-match, title; with and without `allowed`), the daemon facade's `ILexicalResult` (through a real socket server with the `vault` + `lexical` services) deep-equals `createStandaloneLexicalReader`'s over the same files and graph, and `search_notes`' payload through `test/_gate.ts` is identical whichever reader the registry entry holds.
- **Freshness under sharing**: an edit, then a call, sees the edit (through the daemon); a call that arrives during a refresh is served by a refresh that started after it (fake `stat` with a barrier); `allowed` never evicts (a filtered call followed by an unfiltered one re-parses nothing); a scope change drops the excluded notes on the next call.
- **Warm on attach**: a cold entry's first `lexical.search` returns the full ranking (it waited for the warm) and `daemon.info` reports `warming` then `ready`.
- **Errors**: `NOT_ATTACHED` for a vault this connection never attached; `LEXICAL_FAILED` when the reader throws; a 30 s timeout fails `search_notes` with `DEPENDENCY_ERROR` and does not flip the switch; a `"semantic": false` vault attaches with `profiles: []` and serves lexical search.
- **Session wiring**: `search_notes` under `--no-shared` serves lexical through the in-process entry; under the daemon the session process holds no `LexicalIndex` (no parse of any note file by the session for a lexical call, asserted with a spy on the session's reader); `npm run eval` scores identical before and after on both pipelines.

### Q12. Docs

`docs/architecture/lexical-search.md` (the cache is a vault-entry member; the serialised refresh; `allowed` never evicts; the entry's graph; the `ILexicalReader` facade and its three implementations), `vault-entry.md` (members, warm on attach, the "what it deliberately does not do" list loses the lexical cache), `shared-daemon.md` (the `lexical` service, the protocol table row, `LEXICAL_FAILED`, the status line, "how a new service attaches" updated to past tense), `semantic-backend.md` (the attachment is shared; a `"semantic": false` vault attaches), `vault-registry.md` (`IRegisteredVault.lexical`), `module-structure.md`, `mcp-server-shape.md` ("its own lexical cache"), `retrieval-policy.md` if it names `getBacklinkCount`, `docs/guide/installation.md`, `configuration.md`, `README.md` (when the daemon starts; what a session holds), `docs/architecture/README.md` map lines. No new ADR: ADR-0020 already states that the lexical cache is the next vault-entry member reached through the same attach, and this change adds no new invariant; the design says so.

## Acceptance

- `npm test && npm run lint && npm run typecheck && npm run format && npm run build` pass; the test count never drops.
- N sessions on one vault → `daemon status` shows one entry with `clients N` and one `lexical ready <n> notes` line; no session process parses a note for a lexical call.
- Lexical-mode and fused `search_notes` payloads are byte-identical to the in-process ranking for the same disk state (#176 acceptance); `npm run eval` scores do not move on either pipeline.
- A vault with `"semantic": false` serves lexical search through the daemon; `--no-shared` serves it through the in-process entry; a killed daemon fails the next `search_notes` with `DEPENDENCY_ERROR` and the one after reconnects, and the session never builds a lexical cache because a connection dropped.
- Per-session footprint recorded on #158 next to the change 1 numbers, with the daemon's figure per run (one run sampled to +900 s, per the change 1 retrospective), and the effort's end-of-effort percentage against the settled baseline.

## Forks settled by the owner (2026-10-18)

Neither was covered by #165, #163, #176 or change 1. Both were put to the owner with a recommendation; the owner chose A and one PR.

**F1. How does a `--no-semantic` session get its lexical leg?** → **A.**

- **A (chosen): in-process, no daemon.** `--no-semantic` builds no vault clients at all; every vault's `lexical` is the standalone reader (today's `LexicalIndex` + the session's graph), the same object `npm run eval` uses. Keeps the documented promise that `--no-semantic` starts no daemon, keeps the `--no-semantic` floor of the #158 method meaningful, and matches `--no-semantic`'s meaning (no embeddings, and nothing shared for them). Cost: N `--no-semantic` sessions on one vault hold N lexical caches, as today.
- **B (rejected): through the daemon.** `--no-semantic` with shared services on attaches every vault with `profiles: []` and reads `lexical.search`; `--no-semantic --no-shared` stays in-process. One cache per vault for lexical-only sessions too, and the "per-vault state belongs to the entry" rule holds without exception. Cost: a daemon appears for users who turned embeddings off; the in-process fallback of such a session would build a `VaultEntries` with a watcher and a loop with nothing to reconcile just to host a read-through cache; README, installation and configuration docs and the baseline method change.

**F2. One PR or two?** → **One.**

- **One PR (chosen)**: `Refs #158`, `Closes #176`; the daemon side and the session switch land together. A dark first PR would make every attached entry build and warm a cache nobody reads between the PRs (memory in the daemon with no benefit), and this change is about a quarter of change 1 by surface (one service, one entry member, one facade).
- **Two PRs, as change 1 (rejected)**: PR 1 dark (`lexical` service, entry members, status line, `Refs #176`), PR 2 the session switch (`Closes #176`). Mirrors the delivered pattern and reviews the daemon side alone.

## Deferred / out of scope

- **The wikilink graph and its consumers in the daemon** (#172): the entry's graph here serves the lexical tie-break only; the session keeps its own.
- **Watcher-driven invalidation or an FTS-backed lexical implementation**: fits behind `lexical.search` later; the contract promises only "reflects the disk at call time".
- **The startup peak**: measured after this change; if it does not move, it is the separate startup-peak issue named in change 1.
- **The daemon's bimodal settled footprint** (246 vs 368/384 MB): recorded per run in this change's measurement; its cause is not this change's.
- **A note-metadata index or `query_notes` in the daemon**; watching `.gitignore` / `config.json`; a remote provider or vector store.
