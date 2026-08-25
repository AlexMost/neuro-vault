## 1. Foundations — contract, config, embed queue

Parallel-safe: 1.1, 1.2 and 1.3 touch disjoint files and have no ordering
between them.

- [x] 1.1 Add `src/lib/obsidian/semantic-backend.ts` owning `CorpusSnapshot`, `SemanticBackend { snapshot(); status(); dispose() }` and `BackendStatus { state: 'ready' | 'indexing' | 'disabled' | 'unavailable'; indexed?; total?; reason? }` (design D1). Move `CorpusSnapshot` out of `smart-connections-corpus-index.ts`, which imports it from the new home; no behaviour change, `npm run typecheck` is the test.
- [x] 1.2 Give `.neuro-vault/config.json` one owner (design D8): a loader parsing the file once into `{ exclusions?, semantic? }`, with `loadVaultScope` rebuilt on top of it. Tests: `semantic: false` read, missing key means enabled, non-boolean warns on stderr and means enabled, and every existing scope-config case (missing file, invalid JSON, wrong shape, unusable patterns) still behaves identically.
- [x] 1.3 Add a process-wide queued embedder wrapping `EmbeddingProvider` (design D7): FIFO for indexing work, query embeds served ahead of it, one in flight at a time. Tests: ordering across two lanes with a controllable fake provider; a rejected embed does not wedge the queue.

## 2. The own-corpus backend and its lifecycle

Sequential — each task builds on the previous. Depends on 1.1 and 1.3.

- [x] 2.1 Add the corpus-backed snapshot loader: `CorpusStore.listShards()` + `decodeVector` → `{ sources: Map<string, SmartSource>, basenameIndex }`, skipping shards with no note vector (promoted from `eval/backends.ts`; point `eval/backends.ts` at it so there is one implementation). Tests: a shard round-trips into a source with its blocks; a gated note contributes no source; an empty corpus yields an empty snapshot rather than throwing.
- [x] 2.2 Add the per-vault lifecycle implementing `SemanticBackend` (design D2, D3): `disabled` short-circuit; manifest-compatible corpus with shards → load snapshot and report `ready` while reconciling in the background; otherwise report `indexing` with progress counters and build; promote atomically when a pass reports changes; a throwing pass → `unavailable` with the reason and the previous snapshot retained. Tests drive it with fake store/reconcile/clock — no model, no disk.
- [x] 2.3 Add the file watcher (design D6): `chokidar` dependency, one watcher per enabled vault, `.md` only, `ignoreInitial`, `awaitWriteFinish`, dot-paths ignored; events mark the vault dirty and a reconcile runs after ~10 s of quiet; passes never overlap and a change during a pass schedules the next one; a watcher that fails to start or errors logs to stderr and leaves the vault on reconcile-on-start. Tests: fake watcher + fake timers for debounce, coalescing, overlap, and the degradation path.
- [x] 2.4 Implement `dispose()` (design D10): close the watcher, cancel the pending timer, stop re-arming. Test: after dispose, a watcher event schedules nothing and the watcher is closed.

## 3. Wiring the registry and the server

Sequential, and 3.1 must land as one unit — the entry-shape change breaks its call sites in the same typecheck.

- [x] 3.1 Replace `IVaultEntry.corpus` / `semanticAvailable` / `semanticUnavailableReason` with `backend?: SemanticBackend`, swap `IVaultEntryDeps.corpusFactory` for `semanticBackendFactory({ vaultRoot, vaultName, reader, enabled })`, and update every call site in the same task: `resolve-vault.ts`, `search-notes.ts`, `get-similar-notes.ts`, `find-duplicates.ts` and their tests (design D9).
- [x] 3.2 Wire the production factory in `server.ts`: own-corpus lifecycle per vault, shared queued embedder, per-vault `semantic` flag from 1.2, global `--no-semantic` still short-circuiting the module. Stop wiring `createSmartConnectionsCorpusIndex`; the files themselves come out in group 5 (design D13).
- [x] 3.3 Dispose every backend when the stdio transport closes, and return a disposer from `startNeuroVaultServer`. Test: transport close disposes each entry's backend.

## 4. Tool contract

Depends on group 3. 4.1 and 4.2 touch different files and are parallel-safe once 3.1 has landed.

- [x] 4.1 Add `semantic_status` to every `search_notes` return path — hybrid, `mode: "lexical"`, the empty-filter early return, the non-ready degradation path, and each fan-out entry — always present, counters only while `indexing` (design D5). Update the tool's description/response-shape prose in the same task.
- [x] 4.2 Add `SEMANTIC_INDEX_BUILDING` (details carry `vault`, `indexed`, `total`) and `SEMANTIC_DISABLED` (names `.neuro-vault/config.json` and the `semantic` key) to the error-code union and to the semantic-vault resolution path; rewrite the `SEMANTIC_INDEX_NOT_FOUND` hint to name `neuro-vault-mcp index --vault <path>` with no mention of Obsidian or Smart Connections. Tests assert the code, the details and the absence of plugin wording.

## 5. Remove Smart Connections

Depends on group 4 — the server must already be serving from the own corpus before its predecessor is deleted. Sequential within the group.

- [x] 5.1 Delete `src/lib/obsidian/smart-connections-loader.ts`, `smart-connections-corpus-index.ts`, `smart-connections-types.ts` and their tests. Re-home `SmartSource`/`SmartBlock` next to the corpus code that now produces them; `CorpusSnapshot` already moved in 1.1. Nothing in `src/` may import a Smart Connections symbol afterwards.
- [x] 5.2 Remove `smartEnvPath` from `IVaultConfig` (`src/types.ts`) and from `buildVaultConfig` (`src/config.ts`), plus every test fixture that sets it.
- [x] 5.3 Drop the `--backend` axis from the harness: `eval/backends.ts` keeps one loader, `eval/run.ts` loses the flag and rejects it, the report stops recording `backend`, and `eval/README.md` is updated. Tests in `test/eval/` follow.

## 6. Documentation

Parallel-safe among themselves; all depend on groups 4 and 5 being settled.

- [x] 6.1 Write `docs/adr/0014-<slug>.md` (design D12): the in-process watcher, the `chokidar` runtime dependency, the debounce and its degradation path, and the narrowed "zero infrastructure" claim. Add it to `docs/adr/INDEX.md`.
- [x] 6.2 Add `docs/architecture/semantic-backend.md` — the contract, the four states, startup selection, promotion, the watcher, the shared embed queue, and disposal — and add the lifecycle cross-reference to `docs/architecture/own-corpus.md`. Update `docs/architecture/vault-registry.md` (entry shape, no more `semanticAvailable`) and `docs/architecture/mcp-server-shape.md` (background work, shutdown). Register the new file in `docs/architecture/README.md`.
- [x] 6.3 Sweep `README.md` and `docs/guide/`: restate "Zero infrastructure" honestly (no database, no external processes), replace the "reuses Smart Connections embeddings" framing of the semantic leg, document the per-vault `"semantic"` key in `docs/guide/configuration.md`, document `semantic_status` and the two new error codes in `docs/guide/finding-notes.md`, and note the `index` warm-up in `docs/guide/installation.md`. Delete `docs/architecture/smart-connections-corpus.md` and its entry in `docs/architecture/README.md`. Grep for `smart-env`, `Smart Connections` and `no watchers` across `README.md`, `docs/`, `eval/` and `package.json`, and clear every hit except ADR-0006, whose status becomes fully superseded (its own header and its `docs/adr/INDEX.md` row, following the ADR-0007 precedent).
- [x] 6.4 Update the `openspec/config.yaml` project-context invariant that still reads "semantic search consumes a read-only Smart Connections corpus; the server never writes embeddings (ADR-0006)" so a fresh session is not briefed on a superseded rule.

## 7. Verification

- [x] 7.1 Run the full gates — `npm test`, `npm run lint`, `npm run typecheck` — and confirm the suite count moved only by the tests this change adds.
- [x] 7.2 Smoke the real behaviour against a scratch vault: cold start reports `indexing` and answers lexically, promotion to `ready` happens without a restart, an edited note changes results within the debounce window, `"semantic": false` leaves no corpus directory behind, and the process exits when its client disconnects.
- [ ] 7.3 Fix the `corpus-staleness-filtering` capability's Purpose prose in `openspec/specs/` when the delta is synced — delta specs carry requirements only, and its Purpose still describes a read-only plugin corpus.
