# Tasks — graph-in-daemon

Two PRs (brainstorm §Delivery). PR 1 (`Refs #172`): groups 1–7, then pause and report. PR 2 (`Closes #172`): groups 8–10, ending verify → retrospective → archive → PR.

Parallelism: groups 1 and 2 are parallel-safe with each other (`src/lib/obsidian/graph-reader.ts` vs. `src/daemon/protocol.ts`). Group 3 needs 1. Group 5 needs 1 and 2 and is parallel-safe with 3 and 4 (session files vs. entry and daemon files). Group 4 needs 2 and 3. Group 6 needs 4 and 5. Group 7 is last in PR 1. In PR 2, group 8 is one sequential cut-over (a type change ships with its call sites), group 9 follows it, group 10 is last.

## 1. The graph reader (parallel-safe with 2)

- [ ] 1.1 `src/lib/obsidian/graph-reader.ts`: `IGraphReader`, `GraphReadError`, `createGraphReader(current)` (design D1). Tests over a real `WikilinkGraphIndex` on a stub reader: each read awaits `ensureFresh()` once; counts and resolutions answer in request order, 0 / `null` for unknown paths and targets, empty lists for empty input; `current()` is read once per call, so a swap between calls is seen by the next call only; a rejecting `ensureFresh()` rejects the read as itself.

## 2. The wire rows (parallel-safe with 1)

- [ ] 2.1 `src/daemon/protocol.ts`: `graphNoteLinksParams`, `graphBacklinkCountsParams`, `graphResolveParams`, their result types, three `VaultMethods` rows, `GRAPH_FAILED` (`InternalError`) (design D3). `test/daemon/method-params.test.ts` (or its equivalent table) covers the three schemas: extra keys, wrong types and a missing `vault` are `INVALID_PARAMS`; empty lists pass.
- [ ] 2.2 The unknown-method examples in `test/daemon/protocol.test.ts` and `test/daemon/socket-server.test.ts` name `watch.subscribe` instead of `graph.links` (spec delta, shared-services-daemon).

## 3. The entry's one graph (needs 1)

- [ ] 3.1 `IVaultEntry.graph: IGraphReader` over the entry's current graph; rejects after `dispose()` (design D2). Tests in `test/lib/vault-entry/vault-entry.test.ts`: reads answer over the entry's scope; the tie-break and `graph` read the same build (a link added on disk within the TTL changes neither); `setScope` replaces the graph for both; a read after dispose rejects.
- [ ] 3.2 `VaultEntries.graph(clientId, vault)` sharing a private `attachedEntry` check with `lexical()`. Tests: answered for a client attached with `profiles: []`; `NOT_ATTACHED` for an unattached client or vault; two clients get the same entry's reader.

## 4. The `graph` service (needs 2, 3)

- [ ] 4.1 `src/daemon/services/graph.ts` `createGraphService(entries)` (design D3), registered by `createVaultEntryServices` as `graph`. Tests through a `ServiceRegistry` over fake entries: each method maps params to the reader and the answer to the wire shape; `NOT_ATTACHED` passes through; a throwing read is `GRAPH_FAILED` with its message; malformed params are `INVALID_PARAMS`. `test/daemon/vault-entry-services.test.ts` lists four namespaces.
- [ ] 4.2 Through the in-process link over real `VaultEntries` (temp vault): attach with `profiles: []`, then each `graph.*` method answers from the vault's links; an extra param is `INVALID_PARAMS` exactly as over a `ServiceRegistry`.

## 5. The session view (needs 1, 2; parallel-safe with 3, 4)

- [ ] 5.1 `src/modules/semantic/graph/view.ts` `createGraphReaderView(client)` and `graph/index.ts` (design D4). Tests over a fake `IVaultClient`: each read is one `call` with the right method and params; empty input answers `[]` with no call; a missing or wrong-length list is a `GraphReadError`; `GRAPH_FAILED`, `NOT_ATTACHED`, `DaemonTimeoutError`, `DaemonConnectionError` and a plain throw are each a `GraphReadError` with a message naming the method, keeping the cause.

## 6. Two sessions, one graph (needs 4, 5)

- [ ] 6.1 `test/integration/`: two vault clients on two connections to one socket daemon (`createVaultEntryServices` over real `VaultEntries`, temp vault), each wrapped in `createGraphReaderView`. Session A reads counts; a link is added on disk; session B, attaching after, reads within the TTL and sees A's build; `noteLinks` and `resolve` agree across both. The same reads over the in-process client answer the same.

## 7. PR 1 docs and gates (sequential, last in PR 1)

- [ ] 7.1 `docs/architecture/wikilink-graph.md` (the entry's one graph, `IGraphReader`, the `graph.*` reads, the session graph still in place until PR 2), `vault-entry.md` (the graph member and `VaultEntries.graph`), `shared-daemon.md` (method table rows, `GRAPH_FAILED`, the `graph` service in "how a new service attaches"), `lexical-search.md` (the tie-break reads the shared graph), `module-structure.md` (the `graph/` view). `docs/guide/` untouched: no tool behaviour changes in PR 1.
- [ ] 7.2 `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`, `npx commitlint --from origin/main --to HEAD`; PR 1 with `Refs #172`; pause and report.

## 8. The cut-over (PR 2; sequential — one type change with all its call sites)

- [ ] 8.1 `IRegisteredVault.graph: IGraphReader`; `graphFactory` into `IModuleVaultFactories`; `createVaultClients` supplies the view; `lexicalOnlyVaultFactories` builds one memoized `WikilinkGraphIndex` per vault root for both `graphFactory` (through `createGraphReader`) and the standalone lexical reader; `lexicalReaderFactory` and `listMatchingPathsFactory` stop taking `graph`; every consumer moves to the batched reads (design D5); `makeVaultGraph` returns an `IGraphReader`. Tool tests through `registerTool` + `test/_gate.ts` keep passing with identical payloads.
- [ ] 8.2 One-call-per-tool tests (spec "Each tool reads the graph in batches"): a spy reader counts calls for `get_note_links`, `get_vault_overview`, `vault://overview`, `query_notes` (one and two prefixes), `read_daily`, `search_notes` (matches and none), `get_similar_notes`, and a `search_notes` filter; `--no-semantic` builds one graph per vault and starts no daemon.
- [ ] 8.3 `npm run eval` on the owner's vault: both pipelines identical to main.

## 9. PR 2 docs (needs 8)

- [ ] 9.1 Sweep all of `docs/` (architecture and guide) for the session graph, `ensureFresh`, `IVaultGraph` and "two graphs": `wikilink-graph.md`, `vault-registry.md`, `vault-entry.md`, `vault-scope.md` (scope-change difference), `module-structure.md`, `lexical-search.md`, the guide's `backlink_count` and freshness mentions; `GLOSSARY.md` only if a term is added.

## 10. Close out (sequential, last)

- [ ] 10.1 `/opsx:verify` → `verify.md`; retrospective; `/opsx:archive` (spec sync); gates; PR 2 with `Closes #172`.
