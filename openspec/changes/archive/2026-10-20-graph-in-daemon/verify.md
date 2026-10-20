# Verification Report

**Change**: `graph-in-daemon`
**Verified at**: `2026-10-20 10:40`
**Verifier**: Claude Opus 5.5 (the session that wrote the change). It ran the gates, the eval and the scenario mapping itself. A fresh review subagent read each PR's whole diff (PR 1: no Critical or Important findings, 7 Minor, all fixed in c13c0bb; PR 2: no Critical or Important findings, 8 Minor, 7 fixed in 3768d57, one left as a follow-up below).

Scope: PR 1 (#210, squash-merged as ba5dad3) and PR 2 (branch `claude/graph-cutover`, `ba5dad3..3768d57` before the close-out commit).

### Gates (PR 2 branch head)

| Gate | Result |
| --- | --- |
| `npm test` | 2841 passed, 4 skipped (main ba5dad3: 2830 passed, 4 skipped; +11 tests) |
| `npm run lint` (`eslint .`) | clean |
| `npm run typecheck` (`tsc --noEmit`) | clean |
| `npm run format` | clean |
| `npm run build` | success |
| `npx commitlint --from origin/main --to HEAD` | clean |

### Eval (`npm run eval`)

Owner's vault, `harrier-270m`, golden set n=25. Before is `main` (ba5dad3) in a throwaway worktree, after is 76616ee (the cut-over commit); both pipelines.

| pipeline | p@3 | MRR | hit@3 | before = after |
| --- | --- | --- | --- | --- |
| fused | 0.440 | 0.792 | 0.920 | yes |
| semantic | 0.373 | 0.709 | 0.800 | yes |

The reports' `config`, `golden`, `metrics` and `per_query` are equal as JSON. Expected: the eval's path (`runRetrievalPipeline`, `createStandaloneLexicalReader` over its own `WikilinkGraphIndex`) contains no file this change altered in behaviour.

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result**: 26 items, 0 invalid.

---

## 2. Task Completion (`tasks.md`)

- [x] Every task of groups 1–9 is `- [x]`. 10.1 (this close-out) is ticked with the archive commit.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Note |
| --- | --- | --- |
| `shared-wikilink-graph` | ✗ needs sync (new) | synced by `openspec archive` |
| `shared-lexical-search` | ✗ needs sync (MODIFIED, one requirement) | synced by `openspec archive` |
| `shared-vault-entry` | ✗ needs sync (MODIFIED, one requirement) | synced by `openspec archive` |
| `shared-services-daemon` | ✗ needs sync (MODIFIED, one requirement) | synced by `openspec archive` |

---

## 4. Design / Specs Coherence Spot Check

| Sample | design | specs | Gap |
| --- | --- | --- | --- |
| D1 async batched reader | `IGraphReader`: `noteLinks`, `backlinkCounts`, `resolve` | "A session reads each vault's graph through one graph reader" | none |
| D3 three wire methods, `GRAPH_FAILED` | `graph.noteLinks` / `backlinkCounts` / `resolve` | "The daemon serves graph reads in batches"; services delta adds `GRAPH_FAILED` | none |
| D5 one call per scan | consumers listed | "Each tool reads the graph in batches" | none |
| F3 TTL freshness | 3 min, one build shared | "Graph freshness is the TTL, owned by the host" | none |
| F4 `--no-semantic` | session hosts one graph per root | reader requirement, `--no-semantic` sentence | none |

**Drift warnings** (non-blocking): none.

### Scenario → test map

| Scenario | Test |
| --- | --- |
| Two sessions, one graph | `test/integration/vault-client.test.ts` "two sessions read one entry graph" |
| The tie-break and the reads agree | `test/lib/vault-entry/vault-entry.test.ts` "reads the tie-break's build: one build, …" (one `rebuild`) |
| A scope change reaches every reader | `vault-entry.test.ts` "setScope replaces the graph its reads answer from" |
| Counts in the order asked | `test/lib/obsidian/graph-reader.test.ts` "answers backlink counts in request order…"; `test/daemon/graph-service.test.ts` "graph.backlinkCounts answers one count per path, in order" |
| Resolution in the order asked | `graph-reader.test.ts` "resolves targets in request order…"; `graph-service.test.ts` "graph.resolve answers…" |
| An attach with no profiles may read the graph | `graph-service.test.ts` "answers from the vault entry a profiles: [] attach reached"; `vault-entries.test.ts` "is entry-level…" |
| An unattached vault is refused | `graph-service.test.ts` "%s answers NOT_ATTACHED…"; `vault-entries.test.ts` "NOT_ATTACHED for a connection…" |
| Both sides validate alike | `test/daemon/method-params.test.ts` (graph rows over the socket and loopback paths) |
| One attach for every reader of a vault | `test/semantic/vault-client/factory.test.ts` "a vault's graph reader rides the same attach as its other views" |
| No daemon under --no-semantic | `test/server-modules.test.ts` "--no-semantic opens no connection, … search_notes or get_note_links call"; `test/semantic/lexical-only-factories.test.ts` |
| A dropped connection fails one read | `test/semantic/graph/view.test.ts` "a dropped connection is a GraphReadError…"; reconnect on the next call is the client's (`test/semantic/vault-client/client.test.ts`) |
| search_notes stamps every match from one call | `test/semantic/tools/search-notes.test.ts` "enriches single-query results…" (one call), "reads no graph when nothing matched" |
| query_notes counts before filtering | `test/lib/obsidian/query/query-notes.test.ts` "reads the graph once per scanned prefix…" (a `backlink_count` filter) |
| A filter reads no graph | `search-notes.test.ts` "computes a filter over the notes without reading the graph" |
| A later session reads the shared build | `vault-client.test.ts` "two sessions read one entry graph" |
| A stale build rebuilds on read | `test/lib/obsidian/wikilink-graph.test.ts` (TTL rebuild tests); `graph-reader.test.ts` "reads the current graph once and freshens it once per call" |
| N sessions, one cache (lexical delta) | `vault-client.test.ts`; `test/lib/vault-registry.test.ts` (the graph comes from the module factory, no session build) |
| Unknown method (services delta) | `test/daemon/protocol.test.ts`, `test/daemon/socket-server.test.ts` (`watch.subscribe`) |

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [x] PR 1 merged (ba5dad3); PR 2 commits pushed with the close-out

**Commit range**: PR 1 `76104ed..ba5dad3` (squashed); PR 2 `ba5dad3..HEAD`.

---

## 6. Front-Door Routing Leak Detector

- [x] `ls docs/superpowers/specs/*.md` lists nothing

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

| Deferred dogfood | Equivalent automated test | Coverage | Real gap? |
| --- | --- | --- | --- |
| none deferred | — | — | no |

---

## Follow-ups (non-blocking)

- A `GraphReadError` in `search_notes` reaches the client with its message (a single-vault call) or as `INTERNAL_ERROR` in `failed_vaults`, as a raw graph rebuild error did before this change. The lexical leg maps its failures to `DEPENDENCY_ERROR` with a generic message; mapping graph failures the same way is a small, separate behaviour change.
- Watcher-driven or incremental graph freshness (brainstorm F3).

---

## Overall Decision

- [x] ✅ PASS
- [ ] ⚠️ PASS WITH WARNINGS
- [ ] ❌ FAIL
