# Verification Report

> Produced by `/opsx:verify` after the apply phase, to confirm the implementation matches specs, design and
> tasks. Test paths are relative to `test/`; source paths are relative to the repository root. Test evidence is
> `file:line "test name"` (names shortened).

**Change**: `daemon-lexical-search`
**Verified at**: `2026-10-18 20:15`
**Verifier**: Claude Opus 5.5 (the apply session's controller). The scenario mapping in section 4.1 was compiled by a read-only helper agent from the specs and the test suite; the gates, eval and by-hand results were run by the controller.

Scope: the whole change, one PR (#184, branch `claude/modest-cerf-28c63a`). Gates at `5c0c374`, after the final whole-branch review's fix wave (`d6e8d53`, `807e3cc`) and the spec-review fixes (`179b58a`, `5c0c374`). The eval and the by-hand checks ran at `807e3cc`; the only code change after it warms the entry's graph earlier and touches neither ranking nor the session path.

## Summary

| Dimension    | Result |
| ------------ | ------ |
| Completeness | 12 of 16 tasks done. Open: 9.1 (this verify), 9.2 (retrospective), 9.3 (archive + PR), in progress; 9.4 (footprint measurement) runs after the merge by design (D11). 15 requirements and 67 scenarios in 7 delta specs, all with an implementation. |
| Correctness  | 67 scenarios: 62 Covered (test), 7 of them also by hand; 3 Covered (code only); 2 By hand; 0 uncovered. |
| Coherence    | 12 design decisions: 7 followed, 5 followed with recorded deviations (D2, D4, D7, D8, D10). 0 unrecorded deviations. An independent spec-against-code read found 3 Important spec issues, fixed before archive (section 4.3). |

---

## 0. Gates

At `5c0c374`:

| gate | result |
| --- | --- |
| `npm test` | pass: 162 files passed, 1 skipped; **2482 tests passed / 4 skipped** |
| `npm run lint` | clean (exit 0) |
| `npm run typecheck` | clean (exit 0) |
| `npm run format` | clean (exit 0) |
| `npm run build` | pass (exit 0) |
| `npx commitlint --from origin/main --to HEAD` | pass (exit 0) |
| `npx openspec validate --all --strict` | 24 passed, 0 failed |

### Eval (`npm run eval`, offline retrieval quality)

Owner's vault, `harrier-270m`, golden set n=25 (ua 21, en 4), same vault commit for both runs. Before is the merge base `e127cba`; after is `807e3cc`.

| pipeline | slice | before p@3 / mrr / hit@3 | after |
| --- | --- | --- | --- |
| semantic | overall | 0.373 / 0.709 / 0.800 | same |
| semantic | ua | 0.365 / 0.694 / 0.810 | same |
| semantic | en | 0.417 / 0.786 / 0.750 | same |
| fused | overall | 0.440 / 0.792 / 0.920 | same |
| fused | ua | 0.429 / 0.752 / 0.905 | same |
| fused | en | 0.500 / 1.000 / 1.000 | same |

Delta: 0 on every metric. The two reports' per-query rankings are also identical (JSON diff, `code_sha` aside).

---

## 1. Structural Validation (`npx openspec validate --all --json`)

- [x] Every item is `"valid": true`

**Result**:

```text
totals: items 24, passed 24, failed 0
byType: change 1/1 passed, spec 23/23 passed
```

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every `- [ ]` is now `- [x]`. 12 of 16 are checked.

| Task | Why it is open | Blocks archive? |
|---|---|---|
| 9.1 `/opsx:verify` | In progress: this report | No |
| 9.2 `retrospective.md` | Next step, after this report | No |
| 9.3 `npx openspec archive -y`, then the PR | Follows the retrospective | No |
| 9.4 Footprint measurement | Runs by hand after the merge, posted on #158 (design D11) | No |

---

## 3. Delta Spec Sync State

Seven delta specs; the main specs have not been synced yet. Archive does the sync.

| Capability | Sync state | Notes |
|---|---|---|
| `shared-lexical-search` | ✗ needs sync (new capability) | `openspec/specs/shared-lexical-search/` does not exist; archive creates it (ADDED, 5 requirements) |
| `shared-vault-entry` | ✗ needs sync | MODIFIED, 3 requirements |
| `shared-corpus-reads` | ✗ needs sync | MODIFIED, 1 requirement |
| `shared-services-daemon` | ✗ needs sync | MODIFIED, 2 requirements |
| `hybrid-search` | ✗ needs sync | MODIFIED, 2 requirements |
| `semantic-backend-lifecycle` | ✗ needs sync | MODIFIED, 1 requirement |
| `daemon-embedding-provider` | ✗ needs sync | MODIFIED, 1 requirement (added by the spec amendment, section 4.3) |

---

## 4. Design / Specs Coherence Spot Check

### 4.1 Requirements and scenarios

Status key: **Covered (test)**, **Covered (code only)**, **By hand** (cannot be asserted in CI). "also by hand" marks a scenario a test covers that was run on a real vault as well (section 7).

#### hybrid-search (2 requirements, 7 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Lexical corpus freshness without an index | An edit is visible on the next call | Covered (test) | `src/lib/obsidian/lexical/lexical-index.ts:70-99,124-206` (every search is served by a refresh that began after it); `lib/obsidian/lexical/lexical-index.test.ts:57 "sees edits on the next call (mtime cache invalidation)"`. Asserted at the index, which `search_notes` reaches through the reader without a cache of its own (`src/modules/semantic/tools/search-notes.ts:361-380`). |
| | An edit is visible to another session | Covered (code only) | The cache is one per entry, shared by every connection: `src/lib/vault-entry/vault-entry.ts:141-147,375-381`, `src/lib/vault-entry/vault-entries.ts:216-226`. No test edits a note between two sessions or connections; the index-level freshness (`lexical-index.test.ts:57`) and the one-entry sharing (`integration/daemon-vault-entry.test.ts:247 "two connections share one entry"`) are asserted separately. |
| | A filtered search does not slow the next one | Covered (test) | `lexical-index.ts:145-160` (`allowed` is applied after the refresh, never to the cache); `lib/obsidian/lexical/lexical-index.test.ts:191 "a filtered search evicts nothing"` (the second call reads no note, `totalNotes` 12 on both). |
| Lexical leg is independent of the embedding corpus | Lexical search works without a corpus | Covered (test) | `src/modules/semantic/retrieval-pipeline.ts:72-80`; `semantic/tools/search-notes-hybrid.test.ts:201 "mode lexical works with NO corpus and does not touch the loader"`, `:255`; `semantic/tools/search-notes-e2e.test.ts:100 "mode: \"lexical\" on a vault with no semantic backend returns full lexical results ..."`; `server-modules.test.ts:584 "serves search_notes from its lexical leg alone ... under --no-semantic"` |
| | Lexical search works while the index builds | Covered (test) | `src/modules/semantic/tools/search-notes.ts:361-380`; `semantic/tools/search-notes.test.ts:1132 "reports progress while indexing and still returns lexical matches"`; `semantic/tools/search-notes-hybrid.test.ts:223 "hybrid on a cold corpus still returns lexically-sourced matches instead of throwing"`; `server-modules.test.ts:322 "returns SEMANTIC_INDEX_BUILDING with progress ..."` |
| | A semantic leg that throws keeps the lexical matches | Covered (test) | `src/modules/semantic/retrieval-pipeline.ts:72-125` (the lexical leg runs first; a semantic throw becomes `status: 'failed'`); `search-notes.ts:405-425` (`unavailable` status, cause to stderr); `semantic/tools/search-notes.test.ts:175 "degrades to the lexical leg when the query embedding fails"`, `:212 "degrades to the lexical leg when the corpus read fails"`, `:336 "writes the degradation warning to stderr by default"` |
| | A lexical leg that fails is a dependency error | Covered (test), also by hand | `search-notes.ts:390-401` (`LexicalSearchError` to `DEPENDENCY_ERROR`, no switch flip); `src/modules/semantic/lexical/daemon-reader.ts:59-65,80-112`; `semantic/tools/search-notes.test.ts:1486 "a lexical failure is DEPENDENCY_ERROR"`, `:1506 "a lexical failure never flips the semantic fallback status"`; `semantic/lexical/daemon-reader.test.ts:161 "a timeout fails the call and leaves services.mode daemon"`. By hand: a daemon that did not answer `lexical.search` within 30 s gave `DEPENDENCY_ERROR`, and the next call succeeded. |

#### semantic-backend-lifecycle (1 requirement, 5 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| A vault can turn semantics off in its own config | A disabled vault is never indexed | Covered (test) | `src/lib/vault-entry/vault-entry.ts:195-198,240-251` (no corpus, so no watcher), `src/lib/vault-entry/vault-entries.ts:112-127,288-310`; `lib/vault-entry/vault-entry.test.ts:255 "a disabled vault touches nothing under .neuro-vault/corpus/"`, `:438 "a vault with semantic off starts no watcher for an attached profile"`; `lib/vault-entry/vault-entries.test.ts:332 "disabled when the vault's semantic key is false"`; `semantic/backend/factory.test.ts:148 "a disabled vault's semantic backend never attaches by itself"` |
| | A disabled vault still answers lexically | Covered (test) | `src/modules/semantic/backend/index.ts:162-181` (the lexical reader is built whatever `enabled` says); `semantic/tools/search-notes-e2e.test.ts:100`; `semantic/tools/search-notes.test.ts:1019 "fan-out includes a vault without a semantic index, contributing lexically-sourced matches only"`, `:1084`; `semantic/lexical/parity.test.ts:187 "one payload for the three registry entries: lexical mode, backend disabled"` |
| | A disabled vault's lexical leg is shared | By hand | Two shared sessions on a `"semantic": false` vault gave one entry with `clients 2`, no profile and `lexical ready` in `daemon status` (section 7). Parts are asserted separately: `semantic/backend/factory.test.ts:297 "an opted-out vault attaches for its lexical leg with no profiles"`, `integration/daemon-vault-entry.test.ts:272 "profiles [] attaches without a corpus"`, `:422 "lexical.search after profiles [] returns the full ranking"`, `:247 "two connections share one entry"`. No test runs two real sessions on an opted-out vault. |
| | One vault's opt-out does not affect its neighbours | Covered (test) | `src/lib/vault-registry.ts:159-171` (`enabled` per vault); `lib/vault-registry.test.ts:171 "passes the per-vault semantic flag to the backend factory"`, `:192 "builds each entry a lexical reader from its own reader and graph, even with semantic off"`; `semantic/tools/search-notes.test.ts:1019`; `lib/vault-entry/vault-entries.test.ts:332` (the flag is read per entry) |
| | A malformed value falls back to enabled | Covered (test) | `src/lib/obsidian/vault-config.ts:101-108`; `lib/obsidian/vault-config.test.ts:33 "warns and ignores a non-boolean semantic value"` |

#### shared-corpus-reads (1 requirement, 4 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Sessions attach every vault in the background at startup | A status read during a cold start does not wait (renamed by the spec amendment, see 4.3) | Covered (test) | `src/modules/semantic/backend/daemon-backend.ts:97-153,161-200`; `semantic/backend/daemon-backend.test.ts:233 "status reads indexing 0/0 while the attach is in flight"`, `:250 "status reads indexing 0/0 at once while the first ensure locates the daemon"`; `server-modules.test.ts:1045 "startup does not wait for attach"`, `:1090 "status reads indexing 0/0 before attach answers"` |
| | A reconnect re-attaches | Covered (test) | `src/modules/semantic/backend/attachment.ts:54-109` (an attach per epoch); `semantic/backend/attachment.test.ts:82 "re-attaches after a new epoch"`; `semantic/backend/daemon-backend.test.ts:196 "re-attaches after a new epoch"`; `integration/session-daemon.test.ts:190 "a killed server socket is reconnected on the next call"`, `:262 "a restarted server sees one attach before both legs"` |
| | An opted-out vault attaches for its lexical leg | Covered (test), also by hand | `src/modules/semantic/backend/index.ts:106-150,152-170` (`profilesFor`, disabled backend that never attaches); `semantic/backend/factory.test.ts:297 "an opted-out vault attaches for its lexical leg with no profiles"` (shared and `--no-shared`), `:148`; `semantic/backend/attachment.test.ts:104 "profiles [] is sent for an opted-out vault"`; `server-modules.test.ts:987 "attaches every vault at startup without waiting for a call, an opted-out vault with profiles []"`. By hand: an opted-out vault attached with `profiles: []` in a real daemon. |
| | One attach serves both facades | Covered (test) | `index.ts:106-181` (one attachment per vault root, shared by backend and reader); `semantic/backend/factory.test.ts:244 "the semantic backend and the lexical reader of a vault share one attachment"`, `:270`; `semantic/backend/daemon-backend.test.ts:147 "two facades on one attachment send one vault.attach"`; `integration/session-daemon.test.ts:262` (one `vault.attach`, then `corpus.*` and `lexical.search` on its key) |

#### shared-lexical-search (5 requirements, 19 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Each vault entry holds one lexical cache and one tie-break graph | N sessions, one cache | By hand | N sessions on one vault gave one entry `clients N` and one `lexical ready` line in `daemon status` (section 7). Parts are asserted separately: `src/lib/vault-entry/vault-entry.ts:128-147`, `src/modules/semantic/lexical/daemon-reader.ts:80-112`; `integration/daemon-vault-entry.test.ts:247 "two connections share one entry"`; `integration/session-daemon.test.ts:338 "the second lexical call, inside the graph TTL, touches the reader not at all"` (the session's reader is not read for the leg). No test attaches three sessions and searches through each. |
| | An opted-out vault is served | Covered (test), also by hand | `src/lib/vault-entry/vault-entries.ts:216-226` (entry-level, no profile); `src/lib/vault-entry/vault-entry.ts:195-198`; `integration/daemon-vault-entry.test.ts:422 "lexical.search after profiles [] returns the full ranking"`, `:272 "profiles [] attaches without a corpus"` (no corpus directory, nothing embedded); `lib/vault-entry/vault-entries.test.ts:390 "is entry-level: a profiles: [] attach gets the reader"`; `lib/vault-entry/vault-entry.test.ts:433 "profiles [] starts no watcher"` |
| | The cache goes with the entry | Covered (test) | `src/lib/vault-entry/vault-entry.ts:406-409` (`dispose` nulls the index and graph), `:141-147` (a new entry warms a new one); `lib/vault-entry/vault-entry.test.ts:612 "dispose frees the members: a later search rejects"`, `:544 "warms on creation"`; `lib/vault-entry/vault-entries.test.ts:420 "detach starts the entry and profile timers; firing drops them"`; `integration/daemon-vault-entry.test.ts:327 "close plus idle timeout drops the entry"` |
| lexical.search serves the lexical leg over the wire | Same evidence as in-process | Covered (test) | `src/daemon/services/lexical.ts:44-92`; `integration/daemon-vault-entry.test.ts:422 "lexical.search after profiles [] returns the full ranking"` (every query set against the frozen oracle: `notes`, `truncated`, both count maps, `total_notes`); `lib/obsidian/lexical/lexical-index-parity.test.ts:30 "LexicalIndex parity with the frozen oracle"`; `semantic/lexical/parity.test.ts:136`; `daemon/lexical-service.test.ts:69 "maps the result to snake_case and passes matches through"` |
| | A cold cache waits | Covered (test) | `src/lib/obsidian/lexical/lexical-index.ts:124-143` (a search shares the warm's refresh); `integration/daemon-vault-entry.test.ts:422` (the search follows the attach at once and ranks over all 12 notes: `total_notes` equals `FIXTURE_PATHS.length`); `lib/obsidian/lexical/lexical-index.test.ts:206,228` |
| | Not attached | Covered (test) | `src/lib/vault-entry/vault-entries.ts:216-226`, `src/daemon/services/lexical.ts:72`; `lib/vault-entry/vault-entries.test.ts:399 "NOT_ATTACHED for a connection that attached another vault, or none"`, `:411 "NOT_ATTACHED once the connection detached"`; `daemon/lexical-service.test.ts:129 "answers NOT_ATTACHED for a vault the connection did not attach"`; `integration/daemon-vault-entry.test.ts:486 "a lexical call makes a client"` (over the socket) |
| | A failing search | Covered (test) | `src/daemon/services/lexical.ts:73-90`, `src/daemon/protocol.ts:92,106`; `daemon/lexical-service.test.ts:137 "answers LEXICAL_FAILED carrying the thrown message"`; `daemon/protocol.test.ts:154` (`LEXICAL_FAILED` maps to -32603). The connection staying open follows from `socket-server.test.ts:165 "keeps the connection open after an UNKNOWN_METHOD answer"` (any error response). |
| | Closed params | Covered (test) | `src/daemon/services/lexical.ts:62-71` (`onlyKeys`); `daemon/lexical-service.test.ts:110 "answers INVALID_PARAMS for %s, before touching the entry"` (row "a profile key"; also empty queries, non-positive caps, bad `allowed`) |
| The entry's lexical cache is read-through, refreshed serially, and never evicts on allowed | An edit is visible to the next call from any session | Covered (code only) | `lexical-index.ts:70-99,145-206`, one index per entry (`vault-entry.ts:141-147,375-381`). Freshness per call is asserted at the index (`lexical-index.test.ts:57`); no test drives an edit seen by a second connection or session. |
| | A call during a refresh is served by the next one | Covered (test) | `lexical-index.ts:124-143`; `lib/obsidian/lexical/lexical-index.test.ts:206 "a call during a refresh is served by the next one"`, `:228 "concurrent waiters share one follow-up"`, `:253 "a call arriving while the follow-up runs is served by a refresh that starts after it"`, `:287 "queued callers are still served when the refresh they waited on fails"` |
| | A filtered call evicts nothing | Covered (test) | `lexical-index.ts:76-99` (`allowed` after the refresh, `totalNotes: paths.length`); `lib/obsidian/lexical/lexical-index.test.ts:191 "a filtered search evicts nothing"`, `:98 "exposes totalNotes as the pre-scope vault scan count"`; `integration/daemon-vault-entry.test.ts:466 "allowed narrows the ranking; an empty list matches nothing"` |
| | A scope change drops notes on the next call | Covered (test) | `src/lib/vault-entry/vault-entry.ts:322-335` (`setScope` rebuilds the reader, index and graph), `lexical-index.ts:150-155` (drop what the scan no longer lists); `lib/vault-entry/vault-entry.test.ts:580 "setScope drops excluded notes on the next search"` (no `Archive/` note ranked, `totalNotes` the scoped count), `:594 "setScope resets the graph so the new scope shows in tie-breaks"`; `lib/vault-entry/vault-entries.test.ts:228 "scope change on attach calls setScope"` |
| | Served through a pass | Covered (test) | `vault-entry.ts:375-381` (`lexicalSearch` touches neither the loop nor the watcher); `lib/vault-entry/vault-entry.test.ts:620 "a search does not touch the watcher or the loop"` (a pass is pending behind a held reconcile lock and the search is answered) |
| The session reads the lexical leg through one reader | One payload whichever reader serves | Covered (test) | `src/modules/semantic/lexical/{daemon-reader,local-reader,standalone-reader}.ts`; `src/modules/semantic/retrieval-pipeline.ts:72-80` (no backlink function passed to the leg); `semantic/lexical/parity.test.ts:187 "one payload for the three registry entries: ..."` (four mode and backend variants), `:136`; `semantic/lexical/standalone-reader.test.ts:37 "search equals LexicalIndex over the same files"`; `semantic/lexical/local-reader.test.ts:49 "search equals the entry's lexicalSearch"`; `semantic/lexical/daemon-reader.test.ts:98 "sends snake_case params and maps the result"` |
| | A daemon timeout fails one search | Covered (test), also by hand | `daemon-reader.ts:59-65,80-112` (a failure never touches the switch; only `ensure()` flips it); `semantic/lexical/daemon-reader.test.ts:161 "a timeout fails the call and leaves services.mode daemon"`, `:177`; `semantic/tools/search-notes.test.ts:1486`. By hand: no answer within 30 s gave `DEPENDENCY_ERROR` and the next call succeeded. |
| | no-semantic stays in-process | Covered (test), also by hand | `src/server.ts:108-120,171-181` (no vault clients, standalone reader); `server-modules.test.ts:630 "--no-semantic opens no connection, at startup or on a search_notes call"` (no `ensure`, no `request`), `:584`; `semantic/lexical/standalone-reader.test.ts:37`. By hand: `--no-semantic` spawned no daemon. |
| | no-shared runs the entry in the session | Covered (test), also by hand | `src/server.ts:171-181`, `src/modules/semantic/backend/index.ts:162-181` (`!opts.shared` gives the local reader); `server-modules.test.ts:1386 "--no-shared serves the lexical leg from the in-process entry"` (`VaultEntries.lexical` called, no `connect`, no `ensure`), `:1328`; `semantic/backend/factory.test.ts:60 "--no-shared serves every vault from one in-process VaultEntries"`, `:270`; `semantic/lexical/local-reader.test.ts:49`. By hand: `--no-shared` served in-process. |
| | A respawned daemon is attached once for both legs | Covered (test) | `attachment.ts:54-109` (one attach per epoch, shared by both facades); `integration/session-daemon.test.ts:262 "a restarted server sees one attach before both legs"` (one `vault.attach` first on the new connection, then `corpus.*` and `lexical.search` on the key it answered); `semantic/lexical/daemon-reader.test.ts:222 "NOT_ATTACHED forgets the attach"`; `semantic/backend/attachment.test.ts:82` |
| daemon.info reports the lexical cache per entry | Warming then ready | Covered (test) | `src/lib/vault-entry/vault-entry.ts:288-300,402`, `lexical-index.ts:111-118`; `lib/vault-entry/vault-entry.test.ts:544 "warms on creation"` (`warming`, then `ready` with `notes` and `last_refresh` = `at`, `parsed`, `ms`; `info(0).lexical` equals it), `:559 "warms to the scoped count under a scope"`; `lib/obsidian/lexical/lexical-index.test.ts:321 "warm then info"`; `daemon/daemon-service.test.ts:57 "info lists vault entries, read at call time"` |

#### shared-services-daemon (2 requirements, 11 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| The daemon speaks JSON-RPC 2.0 over stdio framing with namespaced methods | Info over the socket | Covered (test) | `src/daemon/services/daemon.ts:27`, `src/daemon/socket-server.ts:130-150`; `daemon/socket-server.test.ts:96 "answers requests from two clients and counts them once they send a request"`, `:148 "daemon.info counts the clients but not its own caller"`; `cli-daemon.test.ts:460 "daemon.info reports the running daemon"`; `integration/daemon-vault-entry.test.ts:234` (`daemon.info` over a real socket) |
| | Unknown method | Covered (test) | `src/daemon/protocol.ts:189-195`; `daemon/protocol.test.ts:35 "answers UNKNOWN_METHOD for an unregistered namespace or method"` (includes `graph.links`); `daemon/socket-server.test.ts:165 "keeps the connection open after an UNKNOWN_METHOD answer"` |
| | A bad line isolates one client | Covered (test) | `src/daemon/socket-server.ts:118-135`; `daemon/socket-server.test.ts:316 "closes only the client that sends a bad line"`, `:332`, `:252` |
| | A later service is one registry entry | Covered (test) | `src/daemon/protocol.ts:182-205`, `src/cli-daemon.ts:244` (`lexical` registered beside `embed`, `vault`, `corpus`); `daemon/protocol.test.ts:27 "routes <service>.<method> and wraps the result"`, `:131 "replaces the handlers when a namespace is registered twice"`; `daemon/lexical-service.test.ts:69` (a later service reached through the registry) |
| | A service hears its connection close | Covered (test) | `src/daemon/services/vault.ts:46-59` (hooked before the await), `src/daemon/socket-server.ts:113-115,149-153`; `daemon/vault-service.test.ts:140 "closing the connection detaches it"`, `:171`; `daemon/socket-server.test.ts:232 "runs onClose callbacks when that socket closes, not another"`; `integration/session-daemon.test.ts:157` (the closed session detaches) |
| | Error data beyond the code | Covered (test) | `src/daemon/protocol.ts:108-116,140-146,198` (`DaemonRpcError` data merged beside `code`), `src/daemon/services/corpus.ts:119-126`; `daemon/protocol.test.ts:114 "carries a DaemonRpcError's data into the response, beside code"`, `:170 "merges data beside code"`; `daemon/corpus-service.test.ts:137 "answers CORPUS_NOT_READY with the status for ..."`; `integration/daemon-vault-entry.test.ts:527` |
| | A lexical call makes a client | Covered (test) | `src/daemon/socket-server.ts:139` (`promote` on any method outside `daemon.`, no list of namespaces); `integration/daemon-vault-entry.test.ts:486 "a lexical call makes a client"` (a refused `lexical.search` raises the observer's `clients` to 1); `daemon/socket-server.test.ts:96,126 "does not count a connection that only calls daemon.* methods"` |
| daemon status and daemon stop are the operator surface | Status lists live and stale daemons | Covered (test) | `src/daemon/admin.ts:241-294,360-366`; `cli-daemon.test.ts:720 "status lists a live daemon and sweeps a stale one"`, `:932 "status sweeps an entry whose socket file is gone"`, `:1071` |
| | Status lists vault entries | Covered (test), also by hand | `src/daemon/admin.ts:285-294` (vault line, then lexical line, then profile lines), `:296-328`; `cli-daemon.test.ts:739 "status prints each vault entry and its profiles under the daemon line"` (`clients 2`, `lexical  ready  955 notes  last refresh ... ~3 parsed 41 ms`, the `harrier-270m` line), `:796 "status prints the other profile states"`, `:832 "status prints a ready lexical line without a last refresh, and tolerates a malformed lexical"`. By hand: N sessions gave one `clients N` entry and one `lexical ready` line. |
| | A daemon without a lexical cache | Covered (test) | `src/daemon/admin.ts:315-328` (`lexicalLine` returns `undefined` for an absent or unrecognised value); `cli-daemon.test.ts:866 "a daemon without lexical prints no such line"`, `:832` (malformed values print none) |
| | Stop ends every daemon | Covered (test) | `src/daemon/admin.ts:368-436`; `cli-daemon.test.ts:1217 "stop stops two live daemons of different builds, and status then knows none"`, `:1335 "stop sends daemon.shutdown and does not signal a daemon that answers"`, `:1357` |

#### shared-vault-entry (3 requirements, 14 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| The daemon keeps one vault entry per vault directory, keyed by its realpath | Two paths to one directory share an entry | Covered (test) | `src/lib/vault-entry/vault-entries.ts:130-192,258-285,288-310` (one entry per realpath, created with its lexical cache: `vault-entry.ts:141-147`); `lib/vault-entry/vault-entries.test.ts:148 "same key for trailing slash and symlink"`, `:205 "concurrent attaches of a new vault share one entry"`; `integration/daemon-vault-entry.test.ts:247 "two connections share one entry"` |
| | Two directories get two entries | Covered (test) | `vault-entries.ts:288-310`, `vault-entry.ts:128-147` (each entry builds its own index and graph); `lib/vault-entry/vault-entries.test.ts:159 "two directories get two entries"`; `integration/daemon-vault-entry.test.ts:380 "a vault directory that vanishes is unavailable and does not touch another vault"` |
| vault.attach attaches a connection to an entry and its profiles | A cold vault attaches at once | Covered (test) | `src/daemon/services/vault.ts:46-59`, `vault-entries.ts:130-192`; `lib/vault-entry/vault-entries.test.ts:166 "answers with each profile's status, without waiting for a load"`; `lib/vault-entry/vault-entry.test.ts:249 "a profile on a cold vault reports indexing 0/0 at once"`; `integration/daemon-vault-entry.test.ts:234 "attach then status goes indexing to ready"` |
| | A vault with a compatible corpus becomes ready after attach | Covered (test) | `src/lib/vault-entry/reconcile-loop.ts:240-280` (startup selection); `lib/vault-entry/reconcile-loop.test.ts:225 "serves a compatible corpus immediately and reconciles behind it"`; `integration/daemon-vault-entry.test.ts:234` |
| | An empty profile list attaches the vault alone | Covered (test) | `vault-entries.ts:130-192` (no profile loop work), `vault-entry.ts:141-147` (lexical warm in the background), `:195-198,240-251` (no corpus, no watcher); `lib/vault-entry/vault-entries.test.ts:350 "profiles: [] attaches without a corpus"`; `daemon/vault-service.test.ts:65 "attach accepts an empty profile list"`; `integration/daemon-vault-entry.test.ts:272 "profiles [] attaches without a corpus"` (answer carries no profile, no `.neuro-vault/corpus/`, nothing embedded); `lib/vault-entry/vault-entry.test.ts:544 "warms on creation"` |
| | A vault that disabled semantics | Covered (test) | `vault-entries.ts:112-127,288-310`, `vault-entry.ts:122,306,336-345`; `lib/vault-entry/vault-entries.test.ts:332 "disabled when the vault's semantic key is false"`; `lib/vault-entry/vault-entry.test.ts:255 "a disabled vault touches nothing under .neuro-vault/corpus/"`; `integration/daemon-vault-entry.test.ts:422` (an entry with no corpus serves `lexical.search`) |
| | Attaching twice adds a profile | Covered (test) | `vault-entries.ts:146-165`; `lib/vault-entry/vault-entries.test.ts:218 "attaching twice adds a profile and keeps the first"`, `:481 "an unused profile is freed on its own"` |
| | A missing directory | Covered (test) | `vault-entries.ts:258-285`; `lib/vault-entry/vault-entries.test.ts:174,183,189 "VAULT_UNAVAILABLE for a missing path / a file / a relative path"` (the entry is created only after resolution succeeds); `integration/daemon-vault-entry.test.ts:351 "answers NOT_ATTACHED and VAULT_UNAVAILABLE with data.code"` |
| The entry's watcher follows the vault scope | An edit in an excluded subtree schedules nothing | Covered (test) | `src/lib/vault-entry/watcher.ts:68-80,95`; `lib/vault-entry/watcher.test.ts:64 "rejects a .md under an excluded subtree"`, `:90 "prunes a provably excluded subtree"`; `lib/vault-entry/watcher-chokidar.test.ts:62 "schedules nothing for an excluded subtree, never walks it, and fires for an in-scope note"` |
| | A one-level glob is filtered, not pruned | Covered (test) | `watcher.ts:68-80`; `lib/vault-entry/watcher.test.ts:80 "keeps a note two levels under a one-level glob"`, `:99 "does not prune a one-level glob, whose deeper notes stay in scope"`; `lib/vault-entry/watcher-chokidar.test.ts:83 "under a one-level glob, schedules nothing for a direct child and fires two levels down"` |
| | The server's own writes are ignored | Covered (test) | `watcher.ts:78-80` (dot segments, so `.neuro-vault/` is outside); `lib/vault-entry/watcher.test.ts:76 "ignores the server's own corpus writes"`, `:95 "prunes a dot directory inside the vault"` |
| | Windows paths | Covered (test) | `watcher.ts:52-57`; `lib/vault-entry/watcher.test.ts:50 "converts Windows separators"`, `:84 "judges a Windows path as its vault-relative form"` |
| | No corpus, no watcher | Covered (test) | `vault-entry.ts:162-177,195-198,240-251`; `lib/vault-entry/vault-entry.test.ts:433 "profiles [] starts no watcher"`, `:438 "a vault with semantic off starts no watcher for an attached profile"`, `:444 "the first corpus starts the watcher; a second shares it"` (a profile attached afterwards starts one); `integration/daemon-vault-entry.test.ts:272` |
| | The last corpus leaves | Covered (test) | `vault-entry.ts:244-251` (`detachCorpus` closes the watcher with the last corpus), `:375-381` (`lexicalSearch` independent of it); `lib/vault-entry/vault-entry.test.ts:452 "the last corpus leaving closes it, the one before does not"`, `:620 "a search does not touch the watcher or the loop"`, `:540 "createVaultEntry lexical members"`; `lib/vault-entry/vault-entries.test.ts:481` (a profile freed while the entry stays). No single test frees the last profile and then searches; the two halves are asserted separately. |

#### daemon-embedding-provider (1 requirement, 7 scenarios; added by the spec amendment, see 4.3)

The requirement is canonical and unchanged apart from naming the lexical reader as a third facade of the one-way switch. Rows are carried from change 1's verify, plus the lexical evidence.

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Any failure to reach the daemon falls back once | Spawn fails | Covered (test) | `src/modules/semantic/shared-services.ts:141-185`; `semantic/daemon-connection.test.ts "wraps a spawn throw and still closes the log fd"`; `semantic/shared-services.test.ts "writes one stderr line when two facades both find the daemon unavailable"` |
| | Development run from source | Covered (test) | `daemon-connection.test.ts "refuses to spawn from a TypeScript entry point"`; `semantic/provider-factory.test.ts` |
| | Upgraded under an open session | Covered (test) | `daemon-connection.test.ts "refuses to spawn a daemon for a CLI script rebuilt since this session started"`; `provider-factory.test.ts`; `daemon-embedding-provider.test.ts` |
| | One switch for every facade | Covered (test) | `shared-services.ts:141-185`; `provider-factory.test.ts "shares one connection and one fallback line between providers over the same services"`; `server-modules.test.ts "one fallback line when the daemon cannot start"`; lexical facade: `src/modules/semantic/lexical/daemon-reader.ts:89`, `semantic/lexical/daemon-reader.test.ts "delegates to local once the switch is local"`, `semantic/backend/factory.test.ts` after-switch attachment cases |
| | Model load failure is not a fallback | Covered (test) | `semantic/daemon-embedding-provider.test.ts "does not fall back on EMBED_FAILED and retries through the daemon next time"` |
| | Opting out | Covered (test) | `shared-services.test.ts "is local from the start, with no line and no connection, when not shared"`; `server-modules.test.ts "--no-shared serves the lexical leg from the in-process entry"` |
| | index shares a running server's model | Covered (code only) | `src/cli-index.ts` builds its embedder through `createEmbeddingProvider` and `createSharedServices` with the same `shared` flag; unchanged by this change; no test runs `index` against a live daemon. |


### 4.2 Design adherence (D1–D12)

| Decision | Verdict | Where |
| -------- | ------- | ----- |
| D1 | Followed | `IVaultEntry.lexicalSearch` / `lexicalInfo` at `src/lib/vault-entry/vault-entry.ts:93-94`; one `LexicalIndex` and one `WikilinkGraphIndex` over the entry's scoped reader at `:142-143`, rebuilt by `setScope`, and since `179b58a` both warmed in the background on creation and after `setScope`; `lexicalSearch` at `:375` awaits `graph.ensureFresh()` then searches with the graph's count; `IVaultInfo.lexical` from `lexicalInfo()` at `:288`; no idle timer, members nulled on dispose. |
| D2 | Deviated (recorded) | `src/lib/obsidian/lexical/lexical-index.ts`: whole-scope refresh, `allowed` applied after it, `running` + one shared `queued` follow-up (`:52-53`, `:124-143`), `warm()` never rejects (`:103`), `info()` (`:111`). Two additions beyond the design: each refresh hands its callers a snapshot of the notes it saw, so a later refresh cannot change what a waiting caller ranks; and an optional `readFile` injection as the test seam (controller ruling R2). |
| D3 | Followed | `startWatcher` / `stopWatcher` / `restartWatcher` at `vault-entry.ts:164-192`; started on the first corpus, closed when the last corpus leaves; `setScope` and `onVaultRestored` restart only a running watcher. |
| D4 | Deviated (recorded) | `VaultEntries.lexical()` entry-level check at `src/lib/vault-entry/vault-entries.ts:216`. The warm runs in `createVaultEntry` at creation (and after `setScope`), not in `attach()`; the effect is the same because `attach()` is what creates an entry. |
| D5 | Followed | `createLexicalService` at `src/daemon/services/lexical.ts:61`: closed params, shape → `NOT_ATTACHED` → search → `LEXICAL_FAILED`; types at `src/daemon/protocol.ts:57-72`, `LEXICAL_FAILED` → `InternalError` at `:92,106`; registered at `src/cli-daemon.ts:244`. |
| D6 | Followed | `ILexicalReader` / `LexicalSearchError` at `src/lib/obsidian/lexical/reader.ts:24,35`; readers at `src/modules/semantic/lexical/{standalone-reader,daemon-reader,local-reader}.ts` (`LEXICAL_TIMEOUT_MS = 30_000`); `RetrievalPipelineDeps.lexical: ILexicalReader` without `getBacklinkCount` (`retrieval-pipeline.ts:17`); `IRegisteredVault.lexical` (`vault-registry.ts:55`); `search-notes.ts:393` maps `LexicalSearchError` to `DEPENDENCY_ERROR` and, after the final review, writes the cause to stderr; `eval/pipelines.ts:50` uses the standalone reader. |
| D7 | Deviated (recorded) | `IVaultAttachment` at `src/modules/semantic/backend/attachment.ts:11` has `key()`, `forget()`, `attaching`, `attached` and `statusOf(profile)` instead of the design's `profile` field (rulings R4, R9: the backends need "attached on this epoch" to choose a live status over a recorded one once another facade attached first). `CORPUS_TIMEOUTS` and `isStatus` moved to `backend/corpus-wire.ts`. |
| D8 | Deviated (recorded) | `createVaultClients` at `src/modules/semantic/backend/index.ts:91`; built only under `config.semantic.enabled` (`src/server.ts:173`), otherwise `NO_SEMANTIC_FACTORIES` (`:108`); startup warms every vault at `:239`. Deviation: the daemon reader's `warm()` calls `local().warm()` once the switch went `local` (ruling R5) where the plan said "nothing", so an opted-out vault still attaches after a failed daemon start. |
| D9 | Followed | `lexicalLine` at `src/daemon/admin.ts:315`, printed between the vault line and the profile lines (`:286`); a missing or unrecognised `lexical` prints nothing. |
| D10 | Deviated (recorded) | Oracle `test/lib/obsidian/lexical/_legacy-lexical-index.ts` (verbatim apart from imports and class name); `test/semantic/lexical/parity.test.ts` compares the three readers to it with and without `allowed`, and `search_notes` payloads across readers. "A daemon-served session reads no note" is tested on the second lexical call within the graph TTL (ruling R6), because `search_notes` still builds the session's own graph for `backlink_count`. |
| D11 | Followed (pending) | Measurement after the merge, by hand (task 9.4). |
| D12 | Followed | `docs/architecture/lexical-search.md` and the listed docs, plus `obsidian-lib.md`, `wikilink-graph.md` and `eval/README.md`, whose statements the change made untrue; no ADR, no glossary term. |

**Drift warnings** (non-blocking):

- The `shared-corpus-reads` scenario "A call during a cold start does not wait" holds for the vault's status (it reads `indexing` 0/0 at once), but a `search_notes` lexical leg now waits for the daemon's locate-or-start (at most `POLL_TIMEOUT_MS`, 10 s, then the in-process fallback). Before this change the lexical leg never waited on the daemon. Documented in `docs/architecture/lexical-search.md`. See W2.


### 4.3 Independent spec-against-code read and amendments

Carried forward from change 1's retrospective (candidate "run an independent read of the spec against the code before archive"), an independent reviewer that had not seen the build compared every SHALL sentence of the delta specs with the code at `807e3cc`. It found 3 Important and 7 Minor issues; all were fixed in `179b58a..5c0c374` and re-reviewed as addressed, with `npx openspec validate --all --strict` passing.

| Finding | Fix |
| --- | --- |
| I-1: scenario "A call during a cold start does not wait", but the lexical leg waits for the daemon's locate-or-start and the attach | Spec amended (`shared-corpus-reads`): "A status read during a cold start does not wait"; the lexical leg answers once the daemon started and the vault attached, or in-process if the daemon cannot start |
| I-2: the entry's tie-break graph was promised a background warm but was lazy | Code fix `179b58a`: `buildLexical()` starts the graph build in the background with the cache warm, on creation and after `setScope`; four tests in `lib/vault-entry/vault-entry.test.ts` ("the tie-break graph warms with the cache") |
| I-3: "unreachable … SHALL NOT switch" contradicted the canonical one-way switch | Spec amended (`hybrid-search`): a failed, timed-out or dropped `lexical.search` is `DEPENDENCY_ERROR` and never flips the switch; a daemon that cannot be located or started flips it as for every facade |
| M-1 … M-6 | Wording: 30 s is the session's wait; the session still builds its own graph for `backlink_count`; `warming` again after a scope change; "one cache" and "the scope the cache was built for"; single-vault vs fan-out `failed_vaults`; per-vault attach on each connection |
| M-7: the canonical switch requirement listed only embedding and corpus reads | New delta `specs/daemon-embedding-provider/spec.md` naming lexical reads; `proposal.md` lists the capability |

Accepted residual: a call that waits for an expired graph TTL before joining the refresh rule can land in a different follow-up than a call that arrived in the same run. Rare and harmless; noted, not specified.

---

## 5. Implementation Signal

- [x] No unstaged code: the only uncommitted file at verify time was `tasks.md` (checkbox updates), committed with this report
- [ ] All relevant commits are pushed — the push comes with task 9.3

**Commit range**: `e127cba..5c0c374` (19 commits, plus this report's commit; `ac0df5d` is the propose commit, `5c0c374 docs(openspec): amend daemon-lexical-search specs to what the code does` is HEAD).

---

## 6. Front-Door Routing Leak Detector (warning, non-blocking)

```bash
ls docs/superpowers/specs/*.md 2>/dev/null
```

- [x] No files: the command returns nothing

| File | Captured in the change? | Suggested action |
|---|---|---|
| — | — | — |

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` has no `[~]` rows. The by-hand checks of task 9.1 were run on the owner's vault (959 notes in the lexical cache, 898 in the corpus, macOS, `npm run build` + `node dist/cli.js`, 2026-10-18), driven by a throwaway stdio client in the session scratchpad (not in the repo). A scratch vault with `{ "semantic": false }` stood in for an opted-out vault, so the owner's vault config was not touched.

| By-hand check | Result | Equivalent automated test | Real gap? |
|---|---|---|---|
| N sessions share one entry and one lexical cache | Three shared sessions: `daemon status` printed one vault line `clients 3`, `lexical  ready  959 notes  last refresh … ~0 parsed 14 ms` and the profile line `harrier-270m  ready  898 notes`. Lexical and hybrid `search_notes` succeeded in each session. | `integration/session-daemon.test.ts` "two sessions share one entry"; `cli-daemon.test.ts` status-line tests | No |
| An opted-out vault attaches with `profiles: []` | The scratch vault appeared in `daemon status` with `clients 1` and a `lexical  ready  3 notes` line and no profile line; `search_notes` answered with `semantic_status: disabled`; nothing was created under its `.neuro-vault/` beside `config.json`. | `server-modules.test.ts` "an opted-out vault attaches with profiles []"; `semantic/backend/factory.test.ts` opted-out cases; `lib/vault-entry/vault-entry.test.ts` "profiles [] starts no watcher" | No |
| `--no-semantic` spawns no daemon | With the dev daemon stopped, a `--no-semantic` session answered `search_notes` and `daemon status` listed no daemon of this build. | `server-modules.test.ts` "--no-semantic opens no connection" | No |
| `--no-shared` serves in-process | Same: lexical and hybrid `search_notes` succeeded and no daemon of this build started. | `server-modules.test.ts` "--no-shared serves the lexical leg from the in-process entry" | No |
| A failing daemon costs one `search_notes` | **SIGKILL** of the daemon under a live session: the next `search_notes` did not fail; the session saw the dropped socket, respawned the daemon and re-attached (change 1's reconnect rule). **SIGSTOP** for 50 s: the call failed with `DEPENDENCY_ERROR: Lexical search failed` and `details.vault`; stderr said `daemon did not answer lexical.search in time`; after SIGCONT the next call succeeded. | `semantic/lexical/daemon-reader.test.ts` timeout / drop / `NOT_ATTACHED` cases; `integration/session-daemon.test.ts` "a restarted server sees one attach before both legs"; `semantic/tools/search-notes.test.ts` "a lexical failure is DEPENDENCY_ERROR" | No (see W1) |
| Per-session footprint | Not run in this session: task 9.4, after the merge (D11). | None: a measurement by nature | Measurement only |

---

## Warnings

- **W1: the plan's killed-daemon expectation did not hold.** Plan task 12 step 1 expected "kill the daemon → the next `search_notes` fails with `DEPENDENCY_ERROR`". With SIGKILL the session notices the closed socket before the next call and reconnects transparently, so no call fails. That is better than the expectation and matches change 1's design D11. The failure path the spec names ("the daemon does not answer `lexical.search` within its timeout") was reproduced with SIGSTOP instead and behaves as specified.
- **W2: the lexical leg can wait for the daemon's cold start.** A `search_notes` that arrives while the daemon is being located or started waits for it (bounded by `POLL_TIMEOUT_MS`, then the in-process fallback). The vault's status still reads `indexing` 0/0 at once, as the spec requires. Documented; a candidate follow-up if the wait shows up in practice.
- **W3: the footprint is not measured yet.** The change exists to lower per-session memory; the measurement (task 9.4) follows the merge and is posted on #158.

## Suggestions

1. Deferred minors from the per-task reviews that can stay but are cheap: a `last_refresh` shape guard in `src/daemon/admin.ts` `lexicalLine` (a partial object prints "undefined" pieces); a test pinning that the standalone reader keeps one `LexicalIndex` across calls; a vacuity guard in the parity reader cases; `lexicalInfo()` reporting `warming` forever after a failed first warm.
2. `docs/architecture/vault-entry.md` says `lexicalInfo()` reports `warming` until the first refresh completes; since the amendment the spec also says it reads `warming` again after a scope change replaces the cache. Add that clause.
3. `messageOf` is duplicated in `daemon-reader.ts`, `local-reader.ts` and `shared-services.ts`; `lexical.ts` duplicates `corpus.ts`'s param helpers. A shared helper next to `stringParam` in `protocol.ts` would remove both.

> Post-review (2026-10-18): suggestion 1's `lexicalLine` shape guard and suggestion 2's `warming`-after-scope-change clause are done in the commit `fix(daemon): guard a partial lexical refresh and fix post-review docs`; the rest of suggestion 1 and suggestion 3 stay open.

---

## Overall Decision

- [ ] ✅ PASS — ready for finishing-a-development-branch and archive
- [x] ⚠️ PASS WITH WARNINGS — ready for the next steps, with these noted. W1 is a plan expectation that turned out pessimistic (the real behaviour is better). W2 is a documented behaviour change of the lexical leg under a cold daemon. W3 is the post-merge measurement. No CRITICAL issues.
- [ ] ❌ FAIL — return to the failing artifact, fix it, and re-run verify

**Next step**: `retrospective.md` (task 9.2) → `npx openspec archive -y` (9.3, which syncs the six delta specs) → push to PR #184 with `Refs #158`, `Closes #176`. The footprint measurement (9.4) follows the merge.

**Final assessment**:

Complete for this stage. Every requirement and scenario of the seven delta specs has an implementing code path: 62 of 67 scenarios have a named test, 3 are code-only, and 2 are by-hand checks run on the owner's vault. An independent spec-against-code read found three sentences that would have become false canonical text; one was a missing background warm (fixed in code with tests), two were wording (amended). All 12 design decisions are followed, five with recorded deviations. Eval and per-query rankings are identical before and after. The open items are this flow's own next steps and the post-merge footprint measurement.
