# Verification Report

> Produced by `/opsx:verify` after the apply phase, to confirm the implementation matches specs, design and
> tasks. Test paths are relative to `test/`; source paths are relative to the repository root. Test evidence is
> `file:line "test name"` (names shortened).

**Change**: `daemon-vault-registry`
**Verified at**: `2026-10-18 16:08`
**Verifier**: Claude Sonnet 5.5 (`/opsx:verify` session). The requirement-to-scenario mapping in section 4.1 and the design adherence in 4.2 were done in the apply session; the gates, eval and by-hand results come from the controller.

Scope: PR 2 of the change (PR 1 is merged as `4b7489b`). Verified at `HEAD` (`969b58c`) of `claude/daemon-vault-registry-pr2-02068c`; PR 2 is `4b7489b..HEAD`, 15 commits.

## Summary

| Dimension    | Result |
| ------------ | ------ |
| Completeness | 28 of 31 tasks done. Open: 12.1 (this verify), 12.2 (retrospective), 12.3 (archive + PR 2), all in progress. 25 requirements and 89 scenarios in 7 delta specs, all with an implementation. |
| Correctness  | 89 scenarios: 84 Covered (test), 3 Covered (code only), 2 By hand (run, see section 7), 0 uncovered. No scenario lacks an implementing code path. |
| Coherence    | 17 design decisions: 15 followed, 2 followed with recorded deviations (D3 and D4: `ensureIdentity`, `I` prefixes, `search-engine.ts` deleted, pruned write-back; D9 note: `corpus.*` check order). 0 unrecorded deviations. |

---

## 0. Gates

At `969b58c`:

| gate | result |
| --- | --- |
| `npm test` | pass: 155 files passed, 1 skipped; **2339 tests passed / 4 skipped** |
| `npm run lint` | clean (exit 0) |
| `npm run typecheck` | clean (exit 0) |
| `npm run format` | clean (exit 0) |
| `npm run build` | pass (exit 0) |
| `npx commitlint --from origin/main --to HEAD` | pass (exit 0) |

### Eval (`npm run eval`, offline retrieval quality)

Owner's vault, `harrier-270m`, golden set n=25 (ua 21, en 4). Before is `4b7489b` (the PR 1 merge); after is `969b58c`, and identical at `07ac488` right after the backend swap. The vault's own git HEAD moved between the runs (owner edits); the scores were identical anyway.

| pipeline | slice | before p@3 / mrr / hit@3 | after |
| --- | --- | --- | --- |
| semantic | overall | 0.373 / 0.709 / 0.800 | 0.373 / 0.709 / 0.800 |
| semantic | ua | 0.365 / 0.694 / 0.810 | same |
| semantic | en | 0.417 / 0.786 / 0.750 | same |
| fused | overall | 0.440 / 0.792 / 0.920 | same |
| fused | ua | 0.429 / 0.752 / 0.905 | same |
| fused | en | 0.500 / 1.000 / 1.000 | same |

Delta: 0 on every metric.

---

## 1. Structural Validation (`npx openspec validate --all --json`)

- [x] Every item is `"valid": true`

**Result**:

```text
summary.totals: items 22, passed 22, failed 0
byType: change 1/1 passed, spec 21/21 passed
```

Only INFO-level notes appear (for example "Requirement text is very long" on `vault-scope`); no WARNING or ERROR.

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every `- [ ]` is now `- [x]`. 28 of 31 are checked. The three open ones are the verify, retrospective and archive steps of this very flow, in progress and not blocking.

| Task | Why it is open | Blocks archive? |
|---|---|---|
| 12.1 `/opsx:verify` | In progress: this report | No |
| 12.2 `retrospective.md` | Next step, after this report | No |
| 12.3 `npx openspec archive -y`, then PR 2 | Follows the retrospective | No |

---

## 3. Delta Spec Sync State

Seven delta specs; the main specs have not been synced yet. Archive does the sync.

| Capability | Sync state | Notes |
|---|---|---|
| `shared-vault-entry` | ✗ needs sync (new capability) | `openspec/specs/shared-vault-entry/` does not exist; archive creates it (ADDED, 8 requirements) |
| `shared-corpus-reads` | ✗ needs sync (new capability) | `openspec/specs/shared-corpus-reads/` does not exist; archive creates it (ADDED, 7 requirements) |
| `semantic-backend-lifecycle` | ✗ needs sync | MODIFIED, 5 requirements; the capability exists in main |
| `shared-services-daemon` | ✗ needs sync | MODIFIED, 2 requirements; the capability exists in main |
| `daemon-embedding-provider` | ✗ needs sync | MODIFIED, 1 requirement; the capability exists in main |
| `own-corpus-index` | ✗ needs sync | MODIFIED, 1 requirement; the capability exists in main |
| `hybrid-search` | ✗ needs sync | MODIFIED, 1 requirement; the capability exists in main |

---

## 4. Design / Specs Coherence Spot Check

### 4.1 Requirements and scenarios

Status key: **Covered (test)**, **Covered (code only)**, **By hand** (cannot be asserted in CI).

#### shared-vault-entry (8 requirements, 24 scenarios)

| Requirement                                  | Scenario                                         | Status              | Evidence                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One entry per vault directory, keyed by realpath | Two paths to one directory share an entry        | Covered (test)      | `src/lib/vault-entry/vault-entries.ts:130,243-268,272`; `lib/vault-entry/vault-entries.test.ts:138 "same key for trailing slash and symlink"`, `:195 "concurrent attaches of a new vault share one entry"`; `integration/daemon-vault-entry.test.ts:237 "two connections share one entry"` |
|                                              | Two directories get two entries                  | Covered (test)      | `vault-entries.ts:272-300`; `vault-entries.test.ts:149 "two directories get two entries"`                                                                                                                                                       |
| `vault.attach` attaches a connection         | A cold vault attaches at once                    | Covered (test)      | `src/daemon/services/vault.ts:46-59`; `vault-entry.ts:249`; `vault-entries.test.ts:156 "answers with each profile's status, without waiting for a load"`; `vault-entry.test.ts:242 "a profile on a cold vault reports indexing 0/0 at once"`; `integration/daemon-vault-entry.test.ts:224 "attach then status goes indexing to ready"` |
|                                              | A vault with a compatible corpus becomes ready   | Covered (test)      | `reconcile-loop.ts:230-258` (startup selection); `lib/vault-entry/reconcile-loop.test.ts:225 "serves a compatible corpus immediately and reconciles behind it"`; `integration/daemon-vault-entry.test.ts:224`                                  |
|                                              | An empty profile list attaches the vault alone   | Covered (test)      | `vault-entries.ts:130-192`; `vault-entries.test.ts:340 "profiles: [] attaches without a corpus"`; `daemon/vault-service.test.ts:65 "attach accepts an empty profile list"`; `integration/daemon-vault-entry.test.ts:262 "profiles [] attaches without a corpus"` |
|                                              | A vault that disabled semantics                  | Covered (test)      | `vault-entries.ts:121-123`, `vault-entry.ts:150-158,273`; `vault-entries.test.ts:322 "disabled when the vault's semantic key is false"`; `vault-entry.test.ts:248 "a disabled vault touches nothing under .neuro-vault/corpus/"`                  |
|                                              | Attaching twice adds a profile                   | Covered (test)      | `vault-entries.ts:272-300`; `vault-entries.test.ts:208 "attaching twice adds a profile and keeps the first"`; `:431 "an unused profile is freed on its own"`                                                                                    |
|                                              | A missing directory                              | Covered (test)      | `vault-entries.ts:243-268`; `vault-entries.test.ts:164,173,179 "VAULT_UNAVAILABLE for a missing path / a file / a relative path"`; `integration/daemon-vault-entry.test.ts:341 "answers NOT_ATTACHED and VAULT_UNAVAILABLE with data.code"`      |
| Scope re-read on every attach                | A new exclusion takes effect on the next attach  | Covered (test)      | `vault-entries.ts:154-160`; `vault-entry.ts:265-272`; `vault-entries.test.ts:218 "scope change on attach calls setScope"`; `vault-entry.test.ts:133 "reads fold the scope"`, `:219 "setScope restarts the watcher, queues one pass and applies to reads at once"`; `integration/daemon-vault-entry.test.ts:277` (excluded notes never reach the corpus) |
|                                              | Editing the config alone changes nothing         | Covered (code only) | Nothing watches `config.json` or `.gitignore`: `watcher.ts:78-80` accepts `.md` only; the scope is read only in `vault-entries.ts:121-123,154`. No test asserts the negative.                                                                    |
| `vault.status` reports one profile's state   | Progress is visible                              | Covered (test)      | `vault-entries.ts:195-210`; `vault.ts:60-66`; `reconcile-loop.test.ts:279 "reports indexing with progress before the first index lands"`; `daemon/vault-service.test.ts:88 "status answers the profile state"`                                  |
|                                              | Another connection's vault                       | Covered (test)      | `vault-entries.ts:382-391`; `vault-entries.test.ts:351 "NOT_ATTACHED for another connection's vault"`; `integration/daemon-vault-entry.test.ts:341`                                                                                            |
| A closed connection detaches; entries idle out | A short session gap keeps the corpus warm      | Covered (test)      | `vault-entries.ts:212-223,330-348`; `vault-entries.test.ts:392 "attach during idle reuses"`                                                                                                                                                      |
|                                              | An idle entry is dropped                         | Covered (test)      | `vault-entries.ts:357-368`; `vault-entries.test.ts:371 "detach starts the entry and profile timers; firing drops them"`; `integration/daemon-vault-entry.test.ts:317 "close plus idle timeout drops the entry"`; `lib/vault-entry/vault-entry.test.ts:422` (watcher closed on dispose) |
|                                              | An unused profile is freed on its own            | Covered (test)      | `vault-entries.ts:349-355`; `vault-entries.test.ts:431 "an unused profile is freed on its own"`, `:445`                                                                                                                                          |
| One reconcile loop per entry, one lock       | Two profiles, one lock acquisition               | Covered (test)      | `reconcile-loop.ts:352-367`; `reconcile-loop.test.ts:885 "one lock acquisition for two profiles"`; `obsidian/corpus/reconcile-lock.test.ts` (acquisition)                                                                                        |
|                                              | A profile attached mid-pass                      | Covered (test)      | `reconcile-loop.ts:423-444`; `reconcile-loop.test.ts:899 "a profile added mid-pass is built by the next pass"`                                                                                                                                  |
|                                              | A pass that waited for index                     | Covered (test)      | `reconcile-loop.ts:272`; `reconcile-loop.test.ts:915 "a pass that waited refreshes every corpus"`, `:929 "a pass that waited serves the other holder's vectors without embedding again"`                                                         |
| Watcher follows the vault scope              | An edit in an excluded subtree schedules nothing | Covered (test)      | `watcher.ts:68-80`; `src/lib/obsidian/vault-scope.ts:160`; `lib/vault-entry/watcher.test.ts:64,90 "rejects a .md under an excluded subtree", "prunes a provably excluded subtree"`; `watcher-chokidar.test.ts:62 "schedules nothing for an excluded subtree, never walks it, and fires for an in-scope note"` |
|                                              | A one-level glob is filtered, not pruned         | Covered (test)      | `watcher.test.ts:80,99`; `watcher-chokidar.test.ts:83 "under a one-level glob, schedules nothing for a direct child and fires two levels down"`; `integration/daemon-vault-entry.test.ts:277`                                                    |
|                                              | The server's own writes are ignored              | Covered (test)      | `watcher.test.ts:76 "ignores the server's own corpus writes"`                                                                                                                                                                                    |
|                                              | Windows paths                                    | Covered (test)      | `watcher.ts:52-60`; `watcher.test.ts:50 "converts Windows separators"`, `:84 "judges a Windows path as its vault-relative form"`                                                                                                                |
| Corpus written per note, read with scope folded in | A re-embedded note is served once written  | Covered (test)      | `src/lib/obsidian/corpus/shard-corpus.ts:205-228` (shard first, then memory); `obsidian/corpus/shard-corpus.test.ts:271 "upsert is visible to the next read and replaces the old vectors"`; `reconcile-profile.test.ts:77 "embeds a new note into memory and shards alike"` |
|                                              | An excluded note never ranks                     | Covered (test)      | `vault-entry.ts:218-247` (`foldAnchors`, `exclude`/`allowed` folding, `slot.excluded`); `vault-entry.test.ts:133 "reads fold the scope"`, `:160 "a path anchor on an excluded note not yet swept reads as null"`                                  |

#### shared-corpus-reads (7 requirements, 13 scenarios)

| Requirement                                         | Scenario                                | Status              | Evidence                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus.nearest` and `corpus.nearestBlocks`         | One list per anchor                     | Covered (test)      | `src/daemon/services/corpus.ts:155-191`; `shard-corpus.ts:128-195`; `daemon/corpus-service.test.ts:75 "answers the reader's lists as { hits }"`; `shard-corpus.test.ts:136 "answers one list per anchor, in order"`, `:146 "a path anchor uses the note own vector; a note without one is null"` |
|                                                     | allowed narrows before the limit        | Covered (test)      | `shard-corpus.ts:128-156`; `shard-corpus.test.ts:171 "allowed and exclude apply before limit"`; `integration/daemon-vault-entry.test.ts:457 "allowed and exclude narrow before the limit"`                                                                                |
|                                                     | Wrong dimension                         | Covered (test)      | `corpus.ts:127-133`; `daemon/corpus-service.test.ts:145 "answers INVALID_PARAMS for a vector whose length is not the corpus dimension"`; `integration/daemon-vault-entry.test.ts:557 "refuses what the connection did not attach, an unknown profile and a wrong width"` |
|                                                     | Vectors stay in the daemon              | Covered (test)      | `corpus.ts:165-173` answers `{ hits }` only; `integration/daemon-vault-entry.test.ts:493 "corpus.nearest returns no vectors"` (notes and blocks). The scenario names `get_similar_notes`; the assertion is at the socket, which is where the claim lives.                  |
| A corpus that cannot serve says why                 | A read during the cold build            | Covered (test)      | `corpus.ts:119-126`; `daemon/corpus-service.test.ts:137 "answers CORPUS_NOT_READY with the status for ..."`; `integration/daemon-vault-entry.test.ts:527 "answers CORPUS_NOT_READY with the status while the corpus builds"`; `corpus-service.test.ts:158` (`CORPUS_FAILED`) |
| Session reads through one facade, holds no vector   | No snapshot in the session              | By hand             | Code: `CorpusSnapshot`, `loadCorpusSnapshot`, `createCorpusBackend`, `SearchEngine` and the session watcher are gone (grep over `src/`, `eval/`); `src/modules/semantic/backend/daemon-backend.ts:95-230`; tools import nothing from `src/lib/vault-entry/`. The "holds no decoded corpus" claim is a footprint measurement (task 12.1). |
|                                                     | A status timeout degrades one search    | Covered (test)      | `daemon-backend.ts:51-57,185-202`; `semantic/backend/daemon-backend.test.ts:168 "status timeout reads unavailable"`; `semantic/tools/search-notes.test.ts:241 "a status timeout degrades to lexical with unavailable"`                                                    |
| Sessions attach every vault in the background       | A reconnect re-attaches                 | Covered (test)      | `daemon-backend.ts:108-153`; `semantic/backend/daemon-backend.test.ts:78 "attaches once per epoch"`, `:114 "re-attaches after a new epoch"`; `integration/session-daemon.test.ts:211 "a killed server socket is reconnected on the next call"`; `server-modules.test.ts:926 "attaches every enabled vault at startup..."`, `:969 "startup does not wait for attach"`, `:1014 "status reads indexing 0/0 before attach answers"` |
| A daemon that dies is reconnected, not replaced     | Killed daemon                           | Covered (test)      | `shared-services.ts:141-168`, `daemon-backend.ts:226-228`; `integration/session-daemon.test.ts:211`; `semantic/shared-services.test.ts:87 "stays on the daemon after a connection error and reconnects on the next ensure"`; `semantic/daemon-facade-integration.test.ts:124`. The tests cover the reconnect and re-attach half only: `session-daemon.test.ts:211` restarts the socket server over the same in-memory `VaultEntries`. The real SIGKILL, respawn and warm-load of the entry were done by hand (section 7). |
| Semantic leg composed in the session, ranks as before | Parity with the in-memory leg         | Covered (test)      | `src/modules/semantic/retrieval-policy.ts:125-280`; `semantic/retrieval-parity.test.ts:254 "ranks as the in-memory leg did: $name"` against the frozen oracle `semantic/_legacy-retrieval.ts`; `:271 "reaches fallback, truncation, ties, backfill and expansion"`    |
|                                                     | One call per step for several queries   | Covered (test)      | `retrieval-policy.ts:136-148,202,244`; `semantic/retrieval-parity.test.ts:301 "one nearest call carries every query vector"`                                                                                                                                              |
| `get_similar_notes` and `find_duplicates` compose over reads | A link to a short note        | Covered (test)      | `src/modules/semantic/tools/get-similar-notes.ts:81-110,215`; `semantic/tools/get-similar-notes.test.ts:548 "a link to a short note is a forward_link"`, `:567 "NOT_FOUND when the note has no vector"`                                                                  |
|                                                     | Duplicates are reported once            | Covered (test)      | `src/modules/semantic/tools/find-duplicates.ts:28-60,94`; `semantic/tools/find-duplicates.test.ts:336 "find_duplicates reports a pair once, note_a before note_b"`, `:347 "batches anchors by 64"`, `:373 "returns today's pairs, in today's order, with today's similarities"` |

The requirement text "`CORPUS_FAILED` and `NOT_ATTACHED` SHALL be reported as `DEPENDENCY_ERROR`" is implemented in the two tools (`get-similar-notes.ts:51-56`, `find-duplicates.ts:104-105`; test `get-similar-notes.test.ts:423 "a read that fails inside the corpus is a DEPENDENCY_ERROR"`) and, for `search_notes`, as a lexical-only degradation with `semantic_status` `unavailable` (`search-notes.ts:395-400`).

#### semantic-backend-lifecycle (5 requirements, 21 scenarios)

| Requirement                                  | Scenario                                              | Status              | Evidence                                                                                                                                                                                                                 |
| -------------------------------------------- | ----------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Served from the own corpus through one backend | The semantic leg ranks against the own corpus       | Covered (test)      | `src/lib/vault-entry/vault-entry.ts:283-312`; `integration/daemon-vault-entry.test.ts:429` (reads on a fixture vault); `integration/session-daemon.test.ts:178`                                                            |
|                                              | All three tools see one corpus per vault              | Covered (test)      | One `ICorpusReader` per vault in `src/modules/semantic/backend/{daemon,local}-backend.ts`; `integration/session-daemon.test.ts:178 "two sessions share one entry"` (identical reads)                                      |
|                                              | Each vault has its own backend                        | Covered (test)      | `src/lib/vault-registry.ts:142`; `backend/index.ts:97-116`; `integration/daemon-vault-entry.test.ts:370 "a vault directory that vanishes is unavailable and does not touch another vault"`                                |
| A finished index is promoted live, per vault | A vault becomes searchable mid-session                | Covered (test)      | `reconcile-loop.ts:305-318`; `reconcile-loop.test.ts:288 "promotes the finished index without a restart"`; `integration/daemon-vault-entry.test.ts:224`                                                                   |
|                                              | A note is never served with mixed vectors             | Covered (code only) | `shard-corpus.ts:205-209` replaces a note's whole resident record in one map assignment; `shard-corpus.test.ts:213 "every anchor of one read resolves against the corpus the read began on"` and `:271` approximate it. |
|                                              | Promotion is per vault                                | Covered (test)      | One loop and one status per entry (`vault-entry.ts:100-148`); `integration/daemon-vault-entry.test.ts:370`                                                                                                                |
| Corpus kept fresh while the server runs      | An edited note is re-embedded without a restart       | Covered (test)      | `vault-entry.ts:127-143`; `integration/daemon-vault-entry.test.ts:277 "a note write triggers one pass; an excluded write triggers none"`; `vault-entry.test.ts:388 "debounceMs sets how long a watched change waits before it queues a pass"` |
|                                              | A burst of saves costs one pass                       | Covered (test)      | `watcher.ts:135-190`; `watcher.test.ts:124 "calls onQuiet once after a burst settles"`; `reconcile-loop.test.ts:425 "coalesces pass requests arriving during a pass"`                                                      |
|                                              | A deleted note leaves the served corpus               | Covered (test)      | `reconcile.ts:241` (orphan sweep through `corpus.delete`); `obsidian/corpus/reconcile-profile.test.ts:116 "sweeps an orphan out of memory and disk"`; `shard-corpus.test.ts:314`                                          |
|                                              | Corpus writes do not feed the watcher                 | Covered (test)      | `watcher.ts:68-80`; `watcher.test.ts:76 "ignores the server's own corpus writes"`, `:72`                                                                                                                                  |
|                                              | Five sessions, one watcher                            | By hand             | Entry-level behaviour is tested (`integration/daemon-vault-entry.test.ts:237 "two connections share one entry"`, `integration/session-daemon.test.ts:178`); five real sessions on a real machine is task 12.1.            |
|                                              | A broken watcher degrades rather than fails           | Covered (test)      | `watcher.ts:156-190`; `vault-entry.test.ts:364 "a watcher that fails to start is logged and the entry keeps serving"`; `watcher.test.ts:156,174`                                                                         |
| Background work stops when the transport closes | The process is not held open by a watcher          | Covered (test)      | `src/server.ts:240-300`, `backend/index.ts:117-121`; `server-modules.test.ts:419 "disposes every vault backend when the transport closes"`; `semantic/backend/factory.test.ts:171`; `vault-entry.test.ts:422`            |
|                                              | The client closes its end of the pipe                 | Covered (test)      | `server.ts:290-300`; `server-modules.test.ts:369,400 "disposes every vault backend when the client closes stdin / stdin is destroyed"`                                                                                    |
|                                              | Disconnecting detaches from the daemon                | Covered (test)      | `src/daemon/socket-server.ts:111-118`, `vault.ts:36-43`; `daemon/socket-server.test.ts:232 "runs onClose callbacks when that socket closes, not another"`; `daemon/vault-service.test.ts:140`; `server-modules.test.ts:1118 "transport close detaches"`; `integration/daemon-vault-entry.test.ts:317` |
|                                              | Shutdown does not corrupt the corpus                  | Covered (test)      | Temp-and-rename shard writes (`shard-store.ts`); `obsidian/corpus/reconcile.test.ts:521 "stops at the next note boundary when aborted mid-run"`; `reconcile-loop.test.ts:827 "aborts the pass in flight when disposed"` |
| A backend tolerates other processes reconciling the vault | A note re-embedded by another process is served after the wait | Covered (test) | `reconcile-loop.ts:272`; `reconcile-loop.test.ts:485 "refreshes after a pass that waited for another process, even with nothing changed"`, `:929`                                          |
|                                              | A lock timeout keeps a serving vault ready            | Covered (test)      | `reconcile-loop.ts:370-390`; `reconcile-loop.test.ts:542 "keeps serving through a lock timeout and retries on the backoff"`, `:1003 "a lock timeout restores every profile and warns once"`                                |
|                                              | A lock timeout keeps an unavailable vault unavailable | Covered (test)      | `reconcile-loop.test.ts:571 "stays unavailable, with its reason, when a retry pass times out on the lock"`, `:612`                                                                                                         |
|                                              | A pass that did not wait reads nothing back           | Covered (test)      | `reconcile-loop.ts:272` (`waited && corpus.loaded`); `reconcile-loop.test.ts:599 "does not refresh after a pass that did not wait and changed nothing"`                                                                  |
|                                              | Disposal stops the wait                               | Covered (test)      | `reconcile-loop.ts:461-470`; `obsidian/corpus/reconcile.test.ts:691 "returns the empty summary when aborted while waiting for the lock"`; `reconcile-loop.test.ts:1113 "dispose aborts the reconcile in flight and runs nothing afterwards"` |

#### shared-services-daemon (2 requirements, 9 scenarios)

| Requirement                               | Scenario                                   | Status         | Evidence                                                                                                                                                                                                                     |
| ----------------------------------------- | ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON-RPC 2.0 over stdio framing, namespaced | Info over the socket                     | Covered (test) | `src/cli-daemon.ts:241-258`, `src/daemon/services/daemon.ts`; `daemon/socket-server.test.ts:148 "daemon.info counts the clients but not its own caller"`; `daemon/daemon-service.test.ts`                                       |
|                                           | Unknown method                             | Covered (test) | `src/daemon/protocol.ts:171-185`; `daemon/protocol.test.ts:35 "answers UNKNOWN_METHOD for an unregistered namespace or method"`; `daemon/socket-server.test.ts:165`                                                              |
|                                           | A bad line isolates one client             | Covered (test) | `daemon/socket-server.test.ts:316 "closes only the client that sends a bad line"`                                                                                                                                              |
|                                           | A later service is one registry entry      | Covered (test) | `protocol.ts:171`; `daemon/protocol.test.ts:27 "routes <service>.<method> and wraps the result"`, `:131`; `cli-daemon.ts:241-242` registers `vault` and `corpus` with no framing change                                         |
|                                           | A service hears its connection close       | Covered (test) | `socket-server.ts:111-118`; `daemon/socket-server.test.ts:188 "gives each connection its own context id"`, `:232`; `daemon/vault-service.test.ts:140 "closing the connection detaches it"`                                     |
|                                           | Error data beyond the code                 | Covered (test) | `protocol.ts:94-128`; `daemon/protocol.test.ts:114 "carries a DaemonRpcError's data into the response, beside code"`, `:168`; `semantic/daemon-connection.test.ts:420`; `integration/daemon-vault-entry.test.ts:527`          |
| `daemon status` and `daemon stop` are the operator surface | Status lists live and stale daemons | Covered (test) | `src/daemon/admin.ts:278-330`; `cli-daemon.test.ts:720 "status lists a live daemon and sweeps a stale one"`                                                                                                                    |
|                                           | Status lists vault entries                 | Covered (test) | `admin.ts:280-297,309-330`; `cli-daemon.test.ts:739 "status prints each vault entry and its profiles under the daemon line"`, `:788`, `:822`                                                                                    |
|                                           | Stop ends every daemon                     | Covered (test) | `cli-daemon.test.ts:1151 "stop stops two live daemons of different builds, and status then knows none"`                                                                                                                         |

#### daemon-embedding-provider (1 requirement, 7 scenarios)

| Requirement                                     | Scenario                                  | Status              | Evidence                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any failure to reach the daemon falls back once | Spawn fails                               | Covered (test)      | `src/modules/semantic/shared-services.ts:141-185`; `semantic/daemon-connection.test.ts:287 "wraps a spawn throw and still closes the log fd"`; `semantic/shared-services.test.ts:40 "writes one stderr line when two facades both find the daemon unavailable"` |
|                                                 | Development run from source               | Covered (test)      | `daemon-connection.test.ts:224 "refuses to spawn from a TypeScript entry point"`; `semantic/provider-factory.test.ts:203,221`                                                                                                                |
|                                                 | Upgraded under an open session            | Covered (test)      | `daemon-connection.test.ts:241 "refuses to spawn a daemon for a CLI script rebuilt since this session started"`; `provider-factory.test.ts:171`; `daemon-embedding-provider.test.ts:240`                                                      |
|                                                 | One switch for every facade               | Covered (test)      | `shared-services.ts:141-185`; `shared-services.test.ts:40`; `provider-factory.test.ts:234 "shares one connection and one fallback line between providers over the same services"`; `server-modules.test.ts:1064 "one fallback line when the daemon cannot start"` |
|                                                 | Model load failure is not a fallback      | Covered (test)      | `semantic/daemon-embedding-provider.test.ts:266 "does not fall back on EMBED_FAILED and retries through the daemon next time"`                                                                                                              |
|                                                 | Opting out                                | Covered (test)      | `shared-services.ts:186-195`; `shared-services.test.ts:113 "is local from the start, with no line and no connection, when not shared"`; `provider-factory.test.ts:22`; `server-modules.test.ts:1252 "--no-shared builds local entries and no connection"` |
|                                                 | index shares a running server's model     | Covered (code only) | `src/cli-index.ts:92-96` builds its embedder through `createEmbeddingProvider` and `createSharedServices` with the same `shared` flag; `cli-index.test.ts:182` pins the identity. Unchanged by this change; no test runs `index` against a live daemon. |

#### own-corpus-index (1 requirement, 8 scenarios)

| Requirement                                      | Scenario                                         | Status         | Evidence                                                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconcile passes serialised across processes     | Two concurrent passes do the work once           | Covered (test) | `src/lib/obsidian/corpus/reconcile.ts:170-240`; `obsidian/corpus/reconcile.test.ts:782 "serialises two passes over one vault: the second reuses what the first embedded"`                                                           |
|                                                  | A waiting pass after a rebuild does not rebuild  | Covered (test) | `reconcile.test.ts:794 "a pass that waited on a rebuild reads the new manifest and discards nothing"`                                                                                                                              |
|                                                  | A dead holder is replaced                        | Covered (test) | `src/lib/obsidian/corpus/reconcile-lock.ts`; `obsidian/corpus/reconcile-lock.test.ts:107 "replaces a dead holder on this host without sleeping"`                                                                                    |
|                                                  | A holder on another host is never taken over     | Covered (test) | `reconcile-lock.test.ts:131 "never takes over a holder on another host, even when its pid is not running here"`                                                                                                                     |
|                                                  | A live holder past the bound fails the pass      | Covered (test) | `reconcile-lock.test.ts:185 "gives up after the bound, naming the lock file, host and holder, leaving its lock"`; `cli-index.test.ts:314`                                                                                           |
|                                                  | The lock is released after a failure             | Covered (test) | `reconcile.test.ts:674 "releases the lock when the pass throws"`; `obsidian/corpus/reconcile-profile.test.ts:215 "releases the lock when fn throws"`                                                                                 |
|                                                  | An abort stops the wait                          | Covered (test) | `reconcile-lock.test.ts:359 "stops waiting when aborted, leaving the holder's lock"`; `reconcile.test.ts:691`                                                                                                                       |
|                                                  | Two profiles of one vault share one acquisition  | Covered (test) | `reconcile-loop.ts:352-367`; `lib/vault-entry/reconcile-loop.test.ts:885 "one lock acquisition for two profiles"`                                                                                                                   |

#### hybrid-search (1 requirement, 7 scenarios)

| Requirement                                  | Scenario                                     | Status         | Evidence                                                                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_notes` reports the vault's semantic index state | A ready vault says so             | Covered (test) | `src/modules/semantic/tools/search-notes.ts:123,280`; `semantic/tools/search-notes.test.ts:1106 "reports a ready backend with no counters"`, `:1111 "carries no note when the backend is ready"`                  |
|                                              | A building index is visible in the response  | Covered (test) | `search-notes.test.ts:1125 "reports progress while indexing and still returns lexical matches"`                                                                                                           |
|                                              | A degraded state explains itself             | Covered (test) | `search-notes.test.ts:1116 "... disabled / unavailable"` (the `it.each`)                                                                                                                                    |
|                                              | A status read that times out                 | Covered (test) | `search-notes.ts:280` (`status()` caught to `unavailable` in `daemon-backend.ts:185-202`); `search-notes.test.ts:241 "a status timeout degrades to lexical with unavailable"`                              |
|                                              | Lexical mode still reports the index state   | Covered (test) | `search-notes.test.ts:1155 "reports the state in lexical mode without reading the corpus"`; `:1169 "reads the status once for a search whose semantic leg makes several corpus reads"`                     |
|                                              | An empty filter set still reports the state  | Covered (test) | `search-notes.test.ts:1193 "reports the state on the empty-filter early return"`                                                                                                                          |
|                                              | Fan-out reports state per vault              | Covered (test) | `semantic/tools/search-notes-hybrid.test.ts:447 "carries a per-vault semantic_status in each fan-out entry"`                                                                                              |

**Not covered by a CI test:** the 2 By-hand scenarios, "Five sessions, one watcher" (semantic-backend-lifecycle) and "No snapshot in the session" (shared-corpus-reads, the per-session footprint), were run by hand; the results are in section 7. "Killed daemon" and "index shares a running server's model" are test or code covered; the tests exercise the reconnect and re-attach half of "Killed daemon" only, and the real-process half (SIGKILL, respawn, warm-load) was done by hand (section 7).

### 4.2 Design adherence (D1–D17)

| Decision | Verdict | Where                                                                                                                                                                                                                                                |
| -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1       | Followed  | `src/lib/vault-entry/{vault-entry,vault-entries}.ts`; `IRegisteredVault` untouched; tool code imports nothing from `src/lib/vault-entry/` (only `src/modules/semantic/backend/` and the daemon do).                                                  |
| D2       | Followed  | `MethodHandler = (params, ctx)` at `src/daemon/protocol.ts:105-115`; one `{ id, onClose }` per socket at `src/daemon/socket-server.ts:111-118`; `dispatch(request, ctx)` at `protocol.ts:171`; `embed`/`daemon` ignore it.                              |
| D3       | Deviated (recorded) | `ICorpusReader`/`ICorpusWriter`/`ICorpus` at `src/lib/obsidian/corpus/corpus.ts`; `ShardStore`, `ShardCorpus`, `shardWriter` as designed. The writer carries `ensureIdentity` in place of `reset(identity)` (`corpus.ts:61`, `shard-writer.ts:31`). The scoring moved to `src/lib/obsidian/corpus/{scoring,shard-corpus}.ts` and `search-engine.ts` is deleted. Interface names carry the `I` prefix. `ShardCorpus` also writes a pruned live corpus back from memory (`shard-corpus.ts:229`; tests `shard-corpus.test.ts:396,410`). |
| D4       | Deviated (recorded) | `withReconcileLock` (`reconcile.ts:170`), `reconcileProfile` (`:241`), `reconcileCorpus` as their composition over `shardWriter` (`:117,143`). `reconcileProfile` calls `corpus.ensureIdentity` (`:252`) rather than `identity()` + `reset()`; the design text notes it.                    |
| D5       | Followed  | `reconcile-loop.ts`: per-profile state, one pass with a dirty flag, `RETRY_BASE_MS` 30 s to `RETRY_MAX_MS` 15 min (`pass-outcome.ts`), lock-timeout restore (`:370-390`), abort on dispose (`:461`), refresh after a wait (`:272`), the three-clause guard (`:309`). |
| D6       | Followed  | `VaultScope.isSubtreeExcluded` (`vault-scope.ts:160`); `watcher.ts:52-80,135`, relative path with `/`; `.tmp` clause dropped; watcher lives in `src/lib/vault-entry/watcher.ts`.                                                                       |
| D7       | Followed  | `src/daemon/services/vault.ts`; attach realpaths, validates, re-reads config and scope, swaps scope, tracks clients, answers without waiting (`vault-entries.ts:130-192`); `disabled` from config; embeds through the embed queue (`cli-daemon.ts:233`, `embedderFor: embed.documentsFor`). |
| D8       | Followed  | Per-entry and per-profile client sets and timers (`vault-entries.ts:51-70,330-368`); `0` never idles; profile timer frees the corpus (`:349`), entry timer disposes (`:357`); the daemon's own idle exit is unchanged.                                 |
| D9       | Followed  | `NOT_ATTACHED`, `VAULT_UNAVAILABLE`, `CORPUS_NOT_READY`, `CORPUS_FAILED` and their JSON-RPC mapping at `protocol.ts:66-90`; `data` carried (`:94-128`); `DaemonConnection` surfaces it (`daemon-connection.test.ts:420`). The `corpus.*` handlers check `UNKNOWN_PROFILE` before `NOT_ATTACHED` (`corpus.ts:116-119`), a controller ruling because the other order makes it unreachable. |
| D10      | Followed  | `daemon.info.services.vault` (`protocol.ts:63`, `cli-daemon.ts:256`); `IVaultInfo`/`IProfileInfo` at `vault-entry.ts:19-35` (with `reason`); lines at `admin.ts:278-330`.                                                                               |
| D11      | Followed  | `src/modules/semantic/shared-services.ts`: one connection and one switch, one stderr line (`:141-185`); the embedding provider and corpus facade take it; the corpus facade attaches per epoch (`daemon-backend.ts:108-153`); eager attach at `server.ts:210-217`. Interface is `ISharedServices`. |
| D12      | Followed  | `ISemanticBackend` (`src/lib/obsidian/semantic-backend.ts`) is the reader plus async `status()` and `dispose()`; `daemon-backend.ts` (timeouts `:22-27`) and `local-backend.ts` behind `createSemanticBackends` (`backend/index.ts:76-122`); snapshot and `SearchEngine` gone. Named `ISemanticBackend`, not `SemanticBackend`. |
| D13      | Followed  | `executeRetrieval` over `ICorpusReader` and `allowed` (`retrieval-policy.ts:41-280`): one `nearest` for all queries with `limit + 1`, a fallback `nearest`, one `nearestBlocks`, one backfill per starved seed (`limit: 1`, threshold 0), one expansion `nearest` with `exclude: seeds`; parity test against the frozen oracle.        |
| D14      | Followed  | `get-similar-notes.ts:81-110,215` (one path-anchored `nearest`, `NOT_FOUND` on `null`, basename index from `entry.reader.scan()`); `find-duplicates.ts:28-60,94` (batches of 64, folded pairs, same order).                                              |
| D15      | Followed  | `index` runs in-process through `reconcileCorpus` = `withReconcileLock` + `reconcileProfile` over `shardWriter` (`reconcile.ts:117-143`); `eval/backends.ts:43` loads a `ShardCorpus`, `eval/pipelines.ts:102` runs `executeRetrieval`; a waiting daemon pass refreshes (D5).    |
| D16      | Followed  | PR 1 left the session on `createCorpusBackend` and the session watcher; PR 2 deleted them together with the switch (grep over `src/` finds none of `createCorpusBackend`, `loadCorpusSnapshot`, `CorpusSnapshot`, `SearchEngine`, `vault-watcher`).      |
| D17      | Followed  | `docs/adr/0020-per-vault-state-in-the-daemon.md` and its `docs/adr/INDEX.md` row (ADR-0014 marked superseded in part); `docs/architecture/vault-entry.md` and the updated concept docs; `docs/guide/` and `README.md` carry no stale snapshot, session-watcher or per-session-memory claims. |

**Drift warnings** (non-blocking):

- Design D3 and D4 still list the writer's `reset(identity)`; the code carries `ensureIdentity` (the design bodies note it). See suggestion 3.
- The specs say `vault.attach` and `vault.status` "SHALL answer within 10 seconds", but the 10 s bound is the session's request timeout, not a daemon deadline. See suggestion 2.

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree other than this report: `git status --short` lists only `?? openspec/changes/daemon-vault-registry/verify.md`
- [ ] All relevant commits are pushed — not checked by this run; the push comes with 12.3 (PR 2)

**Commit range**: `4b7489b..969b58c` (15 commits; `969b58c docs: qualify when the daemon starts and when vault config is read` is HEAD).

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

`plan.md` has no `[~]` rows, so nothing was silently deferred. The by-hand checks of task 12.1 were run on the owner's vault instead (about 896 notes in the corpus, macOS, `node dist/cli.js`, 2026-10-18). Each is listed with the automated test that covers the same assertion where one exists.

**Method.** The same driver as the #158 baseline: N stdio sessions, `initialize` plus `search_notes` until `semantic_status.state = ready`, macOS `footprint` at +15/60/120/300 s. Builds main (`4b7489b`) and PR 2 (`969b58c`) were interleaved per N, with a fresh daemon of that build per run, stopped by pid afterwards (never `daemon stop`).

| By-hand check | Result | Equivalent automated test | Coverage assessment | Real gap? |
|---|---|---|---|---|
| N sessions share one entry, no watcher in any session | PR 2 `daemon status` printed one vault line with `clients 1` / `clients 3` / `clients 5` and one profile line `harrier-270m ready 896 notes last reconcile ... +0 ~0 -0`. `lsof`: every PR 2 session holds 0 handles under the vault directory; the daemon holds 1004 (the watcher). On main every session holds 1004 and the daemon 0. | `integration/session-daemon.test.ts:178 "two sessions share one entry"` (one listed entry, `clients: 2`, equal reads, one `vault.attach` per session); `integration/daemon-vault-entry.test.ts:237 "two connections share one entry"` | Wiring from two facades through the socket to one `VaultEntries` entry, and client counting. Not covered: real processes, `daemon status` text, and handle ownership (no watcher in the session is established by the deleted session watcher, D16: grep over `src/` finds none). | ❌ Equivalent for the single-entry and `clients N` assertion; the handle count is by hand only (cannot run in CI) |
| Killed daemon: next call reconnects (done by hand: real SIGKILL, respawn, re-attach, warm-load) | One PR 2 session ready, SIGKILL the daemon. Call 1 returned `semantic_status: indexing` (the session reconnected, respawned the daemon and re-attached; the new entry was loading, warm-loading from the shards on disk). Call 2 returned `ready` with matches. The session never opened a vault-directory handle (0 before and after); no stderr line. | `integration/session-daemon.test.ts:211 "a killed server socket is reconnected on the next call"` (epoch grows, a second `vault.attach`, same hits, `clients` back to 1) | Reconnect, re-attach per epoch and unchanged results | Partial: the test covers the reconnect and re-attach half (the socket server restarts over the same in-memory `VaultEntries`, so no process dies and no entry is rebuilt). Respawn is covered in pieces by `semantic/daemon-connection.test.ts:183 "creates the state dir, spawns detached ..."` and `:488 "rejects pending requests when the socket closes and reconnects on the next call"`. A dead process taking its state with it, and the new entry warm-loading from shards, are by hand only. |
| `--no-shared` runs in-process | One session ready; no daemon of this build started; the session holds 1004 vault-directory handles (its own in-process vault entry and watcher); no stderr line. | `server-modules.test.ts:1252 "--no-shared builds local entries and no connection"` | Local entries are built, the shared-services connection is never ensured (`ensure` spied); handle count not asserted | ❌ Equivalent for the wiring; the handle count is by hand only |
| Per-session footprint at +300 s against the #158 baseline | See the table below. | None: a measurement by nature (perf measurement is manual, not scripted) | — | ❌ Measurement only, not a gap |

### Footprint, settled at +300 s (MB, sessions)

| N | baseline 84ce820 total | main per session | main total | PR 2 per session | PR 2 total | PR 2 vs main |
|---|---|---|---|---|---|---|
| 1 | 190 | 124 | 124 | 93 | 93 | −25% |
| 3 | 477 | 124, 126, 127 | 377 | 99, 95, 95 | 289 | −23% |
| 5 | 812 | 126, 130, 123, 125, 123 | 627 | 97, 95, 107, 94, 92 | 485 | −23% |

Per-session mean at N=5: main 125, PR 2 97 (−23%); baseline about 160 (−39%).

Daemon at +300 s: main 214 / 218 / 223 (N=1/3/5); PR 2 368 / 246 / 384. An extra PR 2 N=3 run sampled to +900 s held flat: sessions 93/94/95, daemon 247 at +300, +600 and +900. The daemon now holds the corpus, the watcher and the loop. In two of four PR 2 runs it settled about 25–30 MB above main; in the other two it sat at 368 and 384 MB at +300 s (+145–160 MB). Whether those two were still holding their startup decode peak (745–847 MB at +15 s) was not settled: the one +900 s run had already settled low by +300 s.

Totals with the daemon at +300 s: N=1 338 → 461 (+36%), N=3 595 → 535 (−10%), N=5 850 → 869 (+2%), dominated by the daemon's variance.

Startup peak (+15 s, sessions total): main 350 / 1072 / 2143, PR 2 249 / 1276 / 2009. Sessions still peak at about 430 MB each for 60–120 s (the session no longer decodes the corpus; the cause was not investigated here, the lexical build is the likely candidate, for change 2 #176 and the startup-peak issue).

---

## Warnings

- **W1: daemon footprint variance, and the total with the daemon.** Per-session memory fell about 23–25% against main and about 39% against the #158 baseline, which is the point of the change. But the daemon now holds the corpus, the watcher and the loop, and in two of four PR 2 runs it settled 145–160 MB above main at +300 s. With the daemon included, the total at N=1 is +36% against main, at N=3 −10%, at N=5 +2%. This is a measured outcome, not a regression in any scenario: the "No snapshot in the session" scenario is about the session, and it holds. The two high daemon runs are unexplained (startup decode peak not yet released versus a real steady state; the one +900 s run held flat low). Record in the retrospective and on #158; follow-up: sample a high-variance run to +900 s.
- **W2: session startup peak.** Sessions still peak near 430 MB each for 60–120 s although they no longer decode the corpus. Cause not investigated (the lexical build is the likely candidate); for change 2 #176 and the startup-peak issue.
- **W3: handle counts are by hand only.** "No watcher in any session" rests on the deleted session watcher plus the by-hand `lsof`, not on a CI assertion.

## Suggestions

1. Add a test for "Editing the config alone changes nothing" (`test/lib/vault-entry/vault-entries.test.ts`, near `:218`): attach, change the vault's config on disk, assert `setScope` is not called and the entry's scope is unchanged until the next attach. The behaviour holds by construction (`src/lib/vault-entry/vault-entries.ts:121-123,154`), but only by absence of code.
2. The specs say `vault.attach` and `vault.status` "SHALL answer within 10 seconds". The daemon itself sets no deadline (`src/daemon/services/vault.ts:22-28` says attach needs none); the 10 s bound is the session's request timeout (`src/modules/semantic/backend/daemon-backend.ts:22-27`). Either reword the two requirements to "the session waits at most 10 seconds" at archive time, or leave as is; behaviour matches the intent.
3. Spec and design still name the writer's `reset(identity)` (design D3 line "ICorpusWriter { ... reset(identity) ... }"). The design bodies of D3 and D4 already carry the `ensureIdentity` note; folding it into the interface list would stop the two readings diverging.
4. "A note is never served with mixed vectors" and "index shares a running server's model" rest on code reading plus nearby tests. If a cheap deterministic test is wanted: a concurrent `upsert` against a `nearest` over one note in `test/lib/obsidian/corpus/shard-corpus.test.ts`, and an `index` run against the socket fixture in `test/integration/`.

---

## Overall Decision

- [ ] ✅ PASS — ready for finishing-a-development-branch and archive
- [x] ⚠️ PASS WITH WARNINGS — ready for the next steps, with these noted. W1 (the daemon footprint variance and the total with the daemon) is a measured outcome to record in the retrospective and on #158. W2 and W3 are follow-ups. No CRITICAL issues; every scenario has an implementing code path and 28 of 31 tasks are done (the other three are this flow).
- [ ] ❌ FAIL — return to the failing artifact, fix it, and re-run verify

**Next step**: `retrospective.md` (task 12.2) → `npx openspec archive -y` (12.3, which syncs the seven delta specs) → open PR 2 to `main` with `Refs #158`, `Closes #175`, `Closes #106`; post the footprint table on #158. Stop there for review.

**Final assessment**:

Complete for this stage: every requirement and scenario of the seven delta specs has an implementing code path, 84 of 89 scenarios have a named test, 3 are code-only with nearby tests, and 2 are by-hand measurements that belong to task 12.1 and cannot run in CI. All 17 design decisions are followed, and the only deviations are the recorded ones (D3/D4 `ensureIdentity`, `corpus.*` check order, `I`-prefixed interface names, `search-engine.ts` deleted with scoring in `corpus/{scoring,shard-corpus}.ts`, pruned live corpus written back from memory). No CRITICAL or WARNING issues. Ready for the retrospective and archive once the controller's gates, eval and by-hand results are filled in above.
