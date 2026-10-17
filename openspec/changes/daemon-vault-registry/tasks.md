# Tasks — daemon-vault-registry

Two PRs. PR 1 (groups 1–6) is dark: no session attaches, session behaviour unchanged. PR 2 (groups 7–12) switches the session over and closes the change. Deliver PR 1, pause for review and merge, then start PR 2.

Parallelism: groups 1 and 3 are parallel-safe with each other (no shared files). Group 2 needs group 1. Group 4 needs 1–3. Group 5 needs 4. In PR 2, group 8 is parallel-safe with tasks 9.1–9.2; 9.3 needs 7, 8, 9.1 and 9.2. Everything else is sequential.

## PR 1 — vault entry in the daemon (dark), `Refs #158`, `Refs #175`

## 1. Corpus interface and its first implementation (parallel-safe with 3)

- [x] 1.1 Rename `CorpusStore` → `ShardStore` (and `CorpusStoreDeps` → `ShardStoreDeps`) with every call site: `src/lib/obsidian/corpus/`, `src/modules/semantic/backend/`, `src/cli-index.ts`, `eval/`, tests. Mechanical; the full suite passes unchanged.
- [x] 1.2 Declare `CorpusAnchor`, `INearestOptions`, `INearestBlocksOptions`, `ICorpusReader`, `ICorpusWriter`, `ICorpusEntry`, `CorpusRecord` and `ICorpus` in `src/lib/obsidian/corpus/corpus.ts` (design D3).
- [x] 1.3 `shardWriter(store)`: a `ICorpusWriter` over `ShardStore` alone (`entries` from the shard listing's metadata, `upsert`/`touch`/`delete` as shard writes, `identity`/`reset` over the manifest, `refresh` a no-op), with unit tests on a temp directory.
- [x] 1.4 Extract the scoring of `search-engine.ts` (`cosineSimilarity`, result ordering) into a module both `SearchEngine` and the new corpus import, with no behaviour change.
- [x] 1.5 `ShardCorpus`: `load()` (decode once), `entries`, per-write memory updates after the shard write, `identity`/`reset` (empties memory), `refresh` (re-read), `vectorOf`, `nearest`, `nearestBlocks` (anchors, `allowed`, `exclude`, `limit`, `null` for a path without a vector), `dispose`. Tests include a parity test: `nearest`/`nearestBlocks` equal `findNeighbors`/`findBlockNeighbors` over the same fixture corpus.

## 2. Reconcile split around the lock (needs 1)

- [x] 2.1 Split `reconcile.ts` into `withReconcileLock(vaultRoot, opts, fn)` and `reconcileProfile(deps, corpus: ICorpusWriter, paths, opts)`; `reconcileCorpus` becomes their composition over `shardWriter(store)`. Every existing reconcile, lock and backend test passes unchanged; new tests drive `reconcileProfile` over a `ShardCorpus` and check memory and shards agree after embed, touch, rename and sweep.

## 3. The watcher follows the scope (#106) (parallel-safe with 1)

- [x] 3.1 `VaultScope.isSubtreeExcluded(relDir)`: dot segment, or a match against the prefix of a `/**` pattern; table tests (`Templates`, `Archive` after a bare entry, `Archive/*` false, `**/drafts`, nested, root).
- [x] 3.2 Watcher predicate: `ignored` prunes a directory only on `isSubtreeExcluded`, events pass only for `.md` with `!isExcluded`; relative path with `/` separators (table test with a Windows-style input); drop the `.tmp` clause. Move the watcher to `src/lib/vault-entry/watcher.ts` and keep the session's factory using it with the scope it already receives.
- [x] 3.3 chokidar integration test on a temp vault: an edit under an excluded subtree schedules nothing; an edit under `Archive/*`'s second level does.

## 4. Vault entry (needs 1–3)

- [x] 4.1 `src/lib/vault-entry/reconcile-loop.ts`: the per-profile state machine of `createCorpusBackend` (startup selection, one pass with a dirty flag, retry backoff, lock-timeout restore, abort on dispose, the empty-corpus guard), walking profiles in attach order under one `withReconcileLock`, refreshing every corpus after a wait. Port the `corpus-backend` tests to it, plus multi-profile tests (one lock acquisition, mid-pass attach).
- [x] 4.2 `IVaultEntry`: scope, watcher, loop, corpus per profile; `addProfile`, `setScope` (restart watcher, queue a pass, fold scope into reads), `status(profile)`, `info()`, `dispose()`.
- [x] 4.3 `VaultEntries`: realpath keying, `attach(connectionId, path, profiles)` (`VAULT_UNAVAILABLE`, `UNKNOWN_PROFILE`, `disabled` from the vault's config, scope re-read), `status(connectionId, vault, profile)` (`NOT_ATTACHED`), `detach(connectionId)`, idle timers per entry and per profile (`0` = never), `info()`, `dispose()`. Tests with fake timers and an injected entry factory.

## 5. Daemon wiring (needs 4)

- [x] 5.1 Per-connection context: `MethodHandler(params, ctx)`, `ServiceRegistry.dispatch(request, ctx)`, `startDaemonServer` creating `{ id, onClose }` per socket; `embed` and `daemon` services unchanged in behaviour.
- [x] 5.2 `DaemonErrorCode` += `NOT_ATTACHED`, `VAULT_UNAVAILABLE`; `DaemonRpcError` and `errorResponse` carry optional `data`; protocol tests.
- [x] 5.3 `vault` service (`attach`, `status`) over `VaultEntries`, registered in `cli-daemon.ts`; the `embed` service exposes a per-profile document embedder and identity for the entries; daemon stop disposes the entries.
- [x] 5.4 `daemon.info.services.vault` and the `daemon status` lines per entry and profile (`src/daemon/admin.ts`), with snapshot-style tests of the printed lines.
- [x] 5.5 Integration test over a real socket and a fixture vault with a fake embedder: attach → `vault.status` `indexing` → `ready`; two connections share one entry (`clients: 2`); `profiles: []`; a note write triggers one pass; an excluded write triggers none; close + idle timeout drops the entry; `NOT_ATTACHED`, `VAULT_UNAVAILABLE`.

## 6. PR 1 delivery

- [x] 6.1 Docs: new `docs/architecture/vault-entry.md`; `shared-daemon.md` (vault service, connection context, status lines), `own-corpus.md` (`ShardStore`, corpus interface, reconcile split), `vault-scope.md` (`isSubtreeExcluded`, watcher), `docs/architecture/README.md` map.
- [x] 6.2 `npm test && npm run lint && npm run typecheck && npm run format && npm run build`; PR 1 to `main` with `Refs #158`, `Refs #175`. Pause for review and merge.

## PR 2 — sessions read through the daemon, `Refs #158`, `Closes #175`, `Closes #106`

## 7. One connection and one switch (needs PR 1)

- [ ] 7.1 `SharedServices` (`src/modules/semantic/shared-services.ts`): one `DaemonConnection`, one switch, one stderr line; `createEmbeddingProvider` and `DaemonEmbeddingProvider` take it instead of owning the fallback. Existing embedding-provider tests pass; new test: a failing attach and an embed share one fallback line.
- [ ] 7.2 `DaemonConnection` surfaces error `data` on `DaemonRpcError`.

## 8. Corpus service in the daemon (parallel-safe with 9.1–9.2)

- [ ] 8.1 `DaemonErrorCode` += `CORPUS_NOT_READY` (with `data.status`), `CORPUS_FAILED`; `corpus` service (`nearest`, `nearestBlocks`) over `VaultEntries`: attach check, profile check, dimension check, scope folded into `allowed`/`exclude`, yield between anchors; unit and socket tests.

## 9. The session over `ICorpusReader`

- [ ] 9.1 `executeRetrieval` over `ICorpusReader` (design D13), with a frozen copy of today's function as a test oracle (`test/semantic/_legacy-retrieval.ts`) and a parity test over a fixture corpus (`quick`, `deep`, with and without `allowed`, explicit and default thresholds, a fallback-threshold query); `runRetrievalPipeline` and `eval` switch to it through a `ICorpusReader` built over the snapshot until 9.3.
- [ ] 9.2 `get_similar_notes` (path anchor, `NOT_FOUND` on `null`, forward links via a basename index of `entry.reader.scan()`) and `find_duplicates` (batches of 64, folded pairs, same order) over `ICorpusReader`, through the same snapshot-built reader; tests for the short-note `forward_link` case and single reporting of a pair.
- [ ] 9.3 Swap `SemanticBackend` to `ICorpusReader + status(): Promise<BackendStatus> + dispose()` with every call site in one task: `LocalSemanticBackend` (in-process `VaultEntries`) and `DaemonSemanticBackend` (attach per epoch, `vault.status` per call with the timeout rule, `corpus.*`, error mapping); `semanticBackendFactory`, `resolveSemanticVault`, `search_notes`' `semantic_status`, server warmup gate, the three tools, `eval`; delete `createCorpusBackend`, `loadCorpusSnapshot`, `CorpusSnapshot`, the snapshot-built reader and `SearchEngine` from tool deps.

## 10. Startup and teardown

- [ ] 10.1 Eager background attach of every semantically enabled vault at startup (`indexing 0/0` until answered); transport close releases the connection (detach) or disposes the local entries; `--no-shared` builds local entries up front. Server tests for each path, including one fallback line when the daemon cannot start.

## 11. Docs and ADR

- [ ] 11.1 ADR-0020 "Per-vault state lives in the daemon's vault entry" (after the owner's ack; supersedes ADR-0014's in-process watcher in part), `docs/adr/INDEX.md`.
- [ ] 11.2 `semantic-backend.md`, `search-engine.md`, `vault-registry.md`, `shared-daemon.md`, `vault-entry.md`, `own-corpus.md`, and a sweep of `docs/guide/` and `README.md` for snapshot, in-process watcher and per-session memory claims.

## 12. Verify, retrospective, archive, PR 2

- [ ] 12.1 `/opsx:verify` → `verify.md`: gates, `npm run eval` scores before and after, and by hand on the owner's vault: N sessions → `daemon status` shows one entry with `clients N` and no watcher in any session; killed daemon → next call reconnects; `--no-shared` in-process; per-session footprint at +300 s against the baseline on #158, posted there.
- [ ] 12.2 `retrospective.md`.
- [ ] 12.3 `npx openspec archive -y`, then PR 2 to `main` with `Refs #158`, `Closes #175`, `Closes #106`.
