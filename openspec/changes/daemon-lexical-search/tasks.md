# Tasks — daemon-lexical-search

One PR (`Refs #158`, `Closes #176`). Delivery order: groups 1–7 in code, then 8 (docs), then 9 (verify → retrospective → archive → PR). The by-hand footprint measurement follows the merge and is posted on #158.

Parallelism: group 1 (the shared `LexicalIndex` refresh rule and the frozen oracle) and group 2 (the lazy watcher in the entry) are parallel-safe with each other (no shared files). Group 3 needs 1 and 2. Group 4 needs 3. Group 5 (the session-side reader interface, standalone reader, pipeline) is parallel-safe with groups 3–4 once group 1 is done. Group 6 needs 4 and 5. Group 7 needs 6. Groups 8 and 9 are sequential after 7.

## 1. The shared refresh rule in `LexicalIndex` (parallel-safe with 2)

- [ ] 1.1 Freeze today's `src/lib/obsidian/lexical/lexical-index.ts` as `test/lib/obsidian/lexical/_legacy-lexical-index.ts` (imports pointed at `src/`), the parity oracle for the rest of the change (design D10).
- [ ] 1.2 `LexicalIndex`: refresh over the whole scope (`reader.scan()`), drop paths the scan no longer lists, never evict on `allowed`; `allowed` applied to the candidate map after the refresh; refreshes serialised with one coalesced follow-up (design D2); new `warm()` (never rejects) and `info()` (`warmed`, `notes`, `lastRefresh`). Tests: never-evict (a filtered call then an unfiltered one re-parses nothing, counted through an injected `stat`/read spy), a call during a refresh is served by one that started after it (barrier on `stat`), concurrent callers share one follow-up, `warm()` then `info()`, and the oracle: identical `search()` output to `_legacy-lexical-index.ts` over a fixture vault for the #177 query sets with and without `allowed`.

## 2. The entry's watcher runs only with a corpus (parallel-safe with 1)

- [ ] 2.1 `createVaultEntry`: start the watcher on the first `attachCorpus`, close it after the last `detachCorpus` (`removeProfile`, idle, `setSemantic(false)`); `setScope` and `onVaultRestored` restart it only while it runs (design D3). Tests: `profiles: []` starts no watcher; attaching a profile starts one; the last profile leaving closes it; `setScope` on a watcher-less entry starts none; existing watcher tests unchanged.

## 3. Lexical members of the vault entry (needs 1, 2)

- [ ] 3.1 `IVaultEntry.lexicalSearch(opts)` and `lexicalInfo()`: one `LexicalIndex` and one `WikilinkGraphIndex` over the entry's scoped reader, rebuilt by `setScope` (graph build time reset), warmed on creation and after `setScope`, disposed with the entry; `IVaultInfo.lexical` (design D1). `VaultEntries.lexical(connectionId, vault)` with the entry-level attach check (`NOT_ATTACHED`), and `attach()` warming a newly created entry (design D4). Tests with an injected entry factory and a real entry over a temp vault: warm on create, scope change drops excluded notes on the next search, `info()` reports `warming` → `ready` with `notes`, entry-level `NOT_ATTACHED` for a connection that attached another vault, members freed on dispose.

## 4. The `lexical` service (needs 3)

- [ ] 4.1 `DaemonErrorCode` += `LEXICAL_FAILED` (`InternalError`); `LexicalSearchParams` / `LexicalSearchResult` in `protocol.ts`; `src/daemon/services/lexical.ts` with `search` (closed params, `queries` non-empty strings, positive integer caps; order shape → `NOT_ATTACHED` → search → `LEXICAL_FAILED`); registered in `startServing` (design D5). Unit tests per error in order, and a socket test in `test/integration/daemon-vault-entry.test.ts`: attach with `profiles: []` then `lexical.search` returns the full ranking (the cold call waited), the result equals the oracle's over the same temp vault, `lexical.search` makes the connection a client.
- [ ] 4.2 `daemon.info.services.vault[].lexical` and the `daemon status` lexical line (`admin.ts`, design D9), with snapshot-style tests including a daemon answer without `lexical`.

## 5. The session-side reader interface, the standalone reader and the pipeline (needs 1; parallel-safe with 3–4)

- [ ] 5.1 `ILexicalReader`, `ILexicalSearchOptions`, `ILexicalResult`, `LexicalSearchError` in `src/lib/obsidian/lexical/reader.ts`; `createStandaloneLexicalReader({ vaultRoot, reader, graph })` in `src/modules/semantic/lexical/standalone-reader.ts` (`warm()` a no-op); `RetrievalPipelineDeps.lexical: ILexicalReader` and `getBacklinkCount` removed; `IRegisteredVault.lexical` built by `IRegisteredVaultDeps.lexicalReaderFactory`; `buildSearchNotesTool` reads `entry.lexical` and maps `LexicalSearchError` to `DEPENDENCY_ERROR`; `eval/pipelines.ts` over the standalone reader; test registries and `_hybrid-helpers.ts` gain `lexical` (design D6). Tests through `test/_gate.ts`: `search_notes` payload unchanged over the standalone reader for the e2e fixtures; a reader that throws `LexicalSearchError` → `DEPENDENCY_ERROR` with the vault in `details`; `npm run eval` unchanged.

## 6. The attachment, the daemon and in-process readers, the vault clients (needs 4, 5)

- [ ] 6.1 `IVaultAttachment` with `createDaemonAttachment` and `createLocalAttachment` (`src/modules/semantic/backend/attachment.ts`), carrying over the semantic backend's per-epoch single-flight attach; `createDaemonSemanticBackend` and `createLocalSemanticBackend` take an attachment instead of owning the attach, with their `status()` rules intact (design D7). Existing backend tests pass unchanged; new tests: two facades on one attachment send one `vault.attach` per epoch, `forget()` after `NOT_ATTACHED` re-attaches once, `profiles: []` for an opted-out vault.
- [ ] 6.2 `createDaemonLexicalReader` and `createLocalLexicalReader` (`src/modules/semantic/lexical/`), error mapping per design D6 (`LEXICAL_FAILED` / timeout / drop / `VAULT_UNAVAILABLE` → `LexicalSearchError`; `NOT_ATTACHED` → forget then `LexicalSearchError`; never the switch), delegation to the in-process reader once `local`. Tests with a fake `IDaemonLink`: result mapping (`matched_queries` → `matchedQueries`), each error, a timeout leaves `services.mode` unchanged, delegation after the switch; local reader over an in-process `VaultEntries`.
- [ ] 6.3 `createSemanticBackends` → `createVaultClients` returning `semanticBackendFactory`, `lexicalReaderFactory`, `dispose`; one attachment per vault root shared by both; `server.ts` builds it only under `config.semantic.enabled`, otherwise hands the registry the standalone factory; startup attaches every registered vault (`backend.status()` where there is a backend, `lexical.warm()` for every vault) (design D8). Server tests: `--no-semantic` opens no connection and spawns nothing while serving `search_notes`; `--no-shared` serves the lexical leg from the in-process entry; an opted-out vault attaches with `profiles: []` under the daemon; teardown still closes services and disposes entries.

## 7. Parity and end-to-end (needs 6)

- [ ] 7.1 `test/semantic/lexical/parity.test.ts`: over one temp vault and the #177 query sets, with and without `allowed`, the standalone, in-process and daemon readers (an in-test `startDaemonServer` with `vault` + `lexical`) each equal the oracle, and `search_notes` through the gate gives one payload whichever reader the registry entry holds; a killed-and-restarted socket server sees one `vault.attach` before the next `corpus.*` and `lexical.search`; a daemon-served session's reader never reads a note file for a lexical call (spy on the session's reader) (design D10).

## 8. Docs

- [ ] 8.1 `docs/architecture/lexical-search.md` (cache as an entry member, the refresh rule, never-evict, the entry's graph, `ILexicalReader` and its three implementations, error mapping), `vault-entry.md`, `shared-daemon.md` (service, protocol row, `LEXICAL_FAILED`, status line, "how a new service attaches"), `semantic-backend.md`, `vault-registry.md`, `module-structure.md`, `mcp-server-shape.md`, `retrieval-policy.md`, `docs/architecture/README.md`, `docs/guide/installation.md`, `configuration.md`, `finding-notes.md` (the `DEPENDENCY_ERROR` row), `README.md` (when the daemon starts). Grep sweep: `LexicalIndex`, `getBacklinkCount`, `lexical cache`, `own lexical`, `every vault set to`, `no-semantic`. No ADR, no glossary term (design D12).

## 9. Verify, retrospective, archive, PR

- [ ] 9.1 `/opsx:verify` → `verify.md`: gates (`npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build`), `npm run eval` scores before and after identical on both pipelines, and by hand on the owner's vault with `npm run build` + `node dist/cli.js`: N sessions → `daemon status` shows one entry with `clients N` and one `lexical ready` line; an opted-out vault attaches with `profiles: []`; `--no-semantic` spawns no daemon; `--no-shared` serves in-process; a killed daemon fails the next `search_notes` with `DEPENDENCY_ERROR` and the one after succeeds.
- [ ] 9.2 `retrospective.md`.
- [ ] 9.3 `npx openspec archive -y`; `npx openspec validate --all --strict`; all gates and `npm run build`; push; PR to `main` with `Refs #158`, `Closes #176`.
- [ ] 9.4 After the merge, by hand (design D11): footprint for N = 1, 3, 5 at +15/+60/+120/+300 s, sessions and daemon per run, one daemon run to +900 s, the `--no-semantic` floor once, posted on #158 next to the change 1 numbers with the effort's percentage against the settled baseline. No script in the repo.
