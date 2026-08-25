# Verification Report

**Change**: `own-backend-integration`
**Verified at**: `2026-08-25 22:32`
**Verifier**: Claude (opsx verify agent)

---

## 1. Structural Validation (`openspec validate --all --json`)

- [x] All items `"valid": true`

**Result** (run by the controller at HEAD `3817474`, cited here rather than re-run per instructions):

```text
openspec validate --all
18 passed, 0 failed (18 items)
```

No failing items to list.

---

## 2. Task Completion (`tasks.md`)

- [ ] All `- [ ]` became `- [x]` — **one exception, see below**

21 of 22 checkboxes are `[x]`.

| Task | Reason unchecked | Blocks archive? |
| --- | --- | --- |
| 7.3 — "Fix the `corpus-staleness-filtering` capability's Purpose prose in `openspec/specs/` when the delta is synced" | Delta specs (`openspec/changes/own-backend-integration/specs/`) carry **Requirements only**, never a Purpose section. `corpus-staleness-filtering`'s Purpose prose still describes a read-only Smart Connections corpus and can only be rewritten once `openspec archive` has synced this change's delta into `openspec/specs/corpus-staleness-filtering/spec.md`. The task is sequenced *after* this verification and after archive by construction — it is not skipped work, it is work whose precondition (the synced main spec existing in its post-archive form) doesn't hold yet. | No — this is the intended order (verify → archive → fix Purpose prose as a fast-follow), not a defect in the change. Flagged here so it isn't lost after archive. |

---

## 3. Delta Spec Sync State

| Capability | Sync status | Notes |
| --- | --- | --- |
| `semantic-backend-lifecycle` | N/A (new capability) | `openspec/specs/semantic-backend-lifecycle/` does not exist yet — confirmed via `ls` (`No such file or directory`). This is the `## ADDED Requirements`-only delta creating a brand-new capability; archive creates the directory. |
| `hybrid-search` | ✗ Needs sync | `openspec/specs/hybrid-search/spec.md` exists but contains none of the delta's `semantic_status` requirement text — confirmed via grep for `semantic_status`, `own corpus`, `.neuro-vault/corpus` (zero hits in the main spec). |
| `corpus-staleness-filtering` | ✗ Needs sync | Main spec at `openspec/specs/corpus-staleness-filtering/spec.md:5,12` still reads "Every tool that derives note paths from **the Smart Connections corpus**… The corpus is read-only and is not watched…" — the delta re-anchors this to the own corpus and a debounced reconcile; not yet applied. |
| `retrieval-eval` | ✗ Needs sync | Main spec at `openspec/specs/retrieval-eval/spec.md:29-40` still documents the two-axis `--pipeline` × `--backend` (`sc`/`own`) runner and a `backend` field in the report — the exact contract this change retires. Not yet applied. |

All three "needs sync" results are expected pre-archive state, not a problem — `openspec archive` is what performs the sync. Recorded per the checklist's instruction to verify rather than assume.

---

## 4. Design / Specs Coherence Spot Check

| Sampled decision | design.md says | specs/ requirement | Gap |
| --- | --- | --- | --- |
| D1 (`SemanticBackend` interface, neutral home) | Two-method interface (`snapshot`, `status`) plus `dispose` (added by D10), living in `src/lib/obsidian/semantic-backend.ts` | `semantic-backend-lifecycle` Req 1: "A backend SHALL expose exactly two reads: a corpus snapshot… and a status." | None — `src/lib/obsidian/semantic-backend.ts:30-34` matches exactly; `dispose()` is covered by Req "Background work stops when the server's transport closes" rather than Req 1, consistent with the design's own split. |
| D3 (startup selection) | Four-branch startup order: disabled → compatible-and-shards → indexing → error handling | `semantic-backend-lifecycle` Req "Startup serves what it can and never blocks" | None — `createCorpusBackend`'s `selectStartupSnapshot`/`initialize` (`src/modules/semantic/backend/corpus-backend.ts:189-223`) implements exactly this branching, and the four scenarios under that requirement are each covered by a named test in `test/semantic/backend/corpus-backend.test.ts`. |
| D5 + its "Refinement (final review)" amendment | A `search_notes` payload may report `semantic_status: unavailable` even though the backend's own `status()` still says `ready`, when the semantic leg fails mid-call | `hybrid-search` "Lexical leg is independent of the embedding corpus" — scenario "a semantic leg that throws keeps the lexical matches": "reports `semantic_status: { state: "unavailable" }` **rather than the `ready` it started from**" | **None — confirmed reflected in the spec, not just design prose.** See detailed check below. |
| D7 (shared embed queue, query-priority lane) | One process-wide `EmbeddingService`, two-lane FIFO, query lane always drains first | `semantic-backend-lifecycle` Req "One embedding model serves the whole process, queries first" | None — `src/modules/semantic/embed-queue.ts:34-42` (`pump()` checks `queryLane` before `indexLane`) matches; both scenarios have dedicated tests in `test/semantic/embed-queue.test.ts`. |
| D9 (registry loses two flags, keeps a factory seam) | `IVaultEntry.backend?: SemanticBackend` replaces `corpus`/`semanticAvailable`/`semanticUnavailableReason`; absent only when the module is globally off | `semantic-backend-lifecycle` Req 1 ("no fallback… no user-facing option selecting a backend") and the opt-out requirement | None — `src/lib/vault-registry.ts:15-55,138-146` matches the described shape and comment-for-comment reasoning. |
| D13 (Smart Connections deleted in this change) | Delete loader/corpus-index/types + tests, `smartEnvPath`, `--backend` axis, `docs/architecture/smart-connections-corpus.md`; ADR-0006 marked superseded | `retrieval-eval` "The pipeline axis selects the ranking method" — "The runner SHALL NOT accept a corpus-selection axis" | None — `grep -rn "smart-connections|SmartConnections|smart-env" src/` returned zero hits; `docs/adr/0006-smart-connections-corpus.md`'s Status line reads "Superseded by [ADR-0013]…, [ADR-0014]…"; `docs/adr/INDEX.md:16` carries the same. |

**D5 refinement — detailed check**: `src/modules/semantic/tools/search-notes.ts:481-499` (the `catch` block around the semantic leg) sets `state: 'unavailable'` on the fallback payload with an inline comment explicitly citing this exact reasoning ("The reported state is `unavailable`, not the pinned `ready`… a lexical-only payload labelled `ready` is exactly the contradiction the pinning above exists to prevent"). Two tests exercise it directly: `test/semantic/tools/search-notes.test.ts:184-207` (query-embedding rejection on a `ready` backend → `semantic_status: { state: 'unavailable' }`) and `:209-238` (unreadable corpus snapshot on a `ready` backend → same). The amendment is not living only in design prose — it is a first-class spec scenario with test coverage.

**Drift warnings (non-blocking)**: none found in the sampled set.

---

## 5. Implementation Signal

- [x] Worktree has no unstaged files (controller-verified; not re-run here per instructions)
- [x] All relevant commits are on the branch (23 commits since merge-base `da67af3`, controller-verified)

**Commit range**: `da67af3..3817474` (23 commits)

---

## 6. Front-Door Routing Leak Detector (warning, non-blocking)

```
$ ls docs/superpowers/specs/*.md
zsh: no matches found: docs/superpowers/specs/*.md
```

- [x] No files present — no leak.

---

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` contains zero `[~]`-marked rows (confirmed: `grep -c '\[~\]' plan.md` → 0). Per the template's own rule, this section may be blank and still PASS. It is filled in anyway because a materially relevant fact would otherwise be lost: the automated suite and the manual smoke cover genuinely different ground, and a reader auditing completeness should see both.

**What the automated suite covers**: every test cited in §§3–4 above drives the system through injected seams — a fake `CorpusStore`, a fake `chokidar` watcher factory, `vi.useFakeTimers()` for the debounce, and a fake/stub embedder. This is real coverage of the state machine, the error contract, and the shutdown-disposal path, but none of it touches a real ONNX model, a real filesystem watcher, or real wall-clock time.

**What the manual smoke covered** (`.superpowers/sdd/plan/task-14-report.md`, task 7.2 in `tasks.md`, run against a real scratch vault):

| Deferred dogfood step | Equivalent automated test | Coverage assessment | Real gap? |
| --- | --- | --- | --- |
| Cold start reports `indexing` and answers lexically (24 ms) | `test/semantic/backend/corpus-backend.test.ts` "reports indexing with progress before the first index lands"; `test/server-modules.test.ts` `startWithBackendStatus({state:'indexing',...})` tests | Same state machine, fake clock/store instead of real disk + real timing | Superseded — timing itself isn't a correctness property |
| Live promotion `indexing → ready` (10.0 s in-process, no restart) | `corpus-backend.test.ts` "promotes the finished index without a restart"; `vault-watcher.test.ts` debounce tests with `vi.useFakeTimers()` | Same promotion logic and debounce logic, faked clock | Superseded for logic; real-clock timing was smoke-only |
| Freshness: edit searchable 15.05 s later, new shard on disk | `vault-watcher.test.ts` "calls onQuiet once after a burst settles"; `corpus-backend.test.ts` real-reconcile tests write real shards to a real temp dir | Debounce + reconcile-to-shard path both unit-tested against real disk (temp dir), just not through a real chokidar watcher end-to-end | Superseded |
| Per-vault opt-out: no corpus directory written | `factory.test.ts` "does not start a watcher for a disabled vault"; `corpus-backend.test.ts` "reports disabled and does no work when the vault opted out" (asserts `reconcile` never called) | Same guarantee, unit-level | Superseded |
| Process exits when client disconnects | `test/server-modules.test.ts:169-380` — boots a **real** `StdioServerTransport` over real `PassThrough` pipes, ends/destroys stdin, asserts `dispose()` is called exactly once per vault and the SDK's own `onclose` still fires | This is the one piece of the smoke that now *also* has a dedicated automated test using a real transport (added as a direct result of the defect the smoke found) | Covered for disposal — **see the one real gap below** |

**The one honest coverage gap**: the smoke's "process exits" claim (23 ms exit measurement) is about actual OS process termination — nothing in the automated suite observes process exit, only resource *disposal* (watcher closed, timers cancelled, `dispose()` called). `test/server-modules.test.ts` proves every vault's backend is disposed and the MCP SDK's own `onclose` fires; it does not spawn a child process and assert on its exit code or the event loop actually draining. The 23 ms figure from the smoke report is a one-time measurement, not a regression-guarded assertion. If `dispose()` were ever satisfied without every handle actually being released (e.g., a future watcher implementation that doesn't fully unref), the unit tests would keep passing while the process again failed to exit — exactly the class of defect the smoke test caught once already (stdin-close not stopping the server, before the fix in this change).

**Follow-up**: a lightweight process-level smoke test (spawn `neuro-vault-mcp` as a real child process, close its stdin, assert the child exits within a timeout) would close this gap and turn a one-time measurement into a regression guard. Worth a small follow-up ticket; not a blocker for this change, since the underlying defect it would catch was already found and fixed by the manual smoke this cycle.

---

## Overall Decision

- [x] ⚠️ **PASS WITH WARNINGS**

**Reasoning**: Structural validation is clean (18/18), 21 of 22 tasks are checked with the one exception (7.3) being correctly sequenced after archive rather than skipped, all four delta specs' requirements map to committed implementation with named test coverage (sampled exhaustively across `semantic-backend-lifecycle`'s 9 requirements, `hybrid-search`'s 3, `corpus-staleness-filtering`'s 1, and `retrieval-eval`'s 3 — no requirement found without an implementing file, and no scenario found asserting behavior the code doesn't have), and the D5 late refinement is verified present in the spec's own scenario text and in test assertions, not just design prose. The three "needs sync" delta capabilities are the expected pre-archive state. No CRITICAL findings.

The WARNINGS, none blocking:

1. One scenario, `semantic-backend-lifecycle` → "An in-flight request keeps a coherent snapshot" (promotion atomicity), has no test that races a search against a mid-flight promotion — the guarantee is structural (immutable snapshot objects, single-assignment replace) and plausible by inspection of `src/modules/semantic/backend/corpus-backend.ts:158-159`, but is not exercised by a dedicated concurrency test.
2. §7's identified gap: process-exit behavior (as opposed to resource disposal) has no automated regression guard — only a one-time manual measurement. Recorded as a follow-up above.
3. Task 7.3 remains open by design; a reader archiving this change should not forget to action it once the delta specs are synced.

**Next step**: proceed to `finishing-a-development-branch` / `openspec archive`. After archive syncs the delta specs, complete task 7.3 (rewrite `corpus-staleness-filtering`'s Purpose prose) as a small immediate follow-up, and consider filing the process-exit smoke-test follow-up from §7.
