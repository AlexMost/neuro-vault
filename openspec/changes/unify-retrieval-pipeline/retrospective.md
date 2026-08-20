# Retrospective: unify-retrieval-pipeline

> Written: 2026-08-20 (after verify passed)
> Commit range: `69adcb5..ffdbc6b`
> Worktree: `.claude/worktrees/unify-retrieval-pipeline` (branch `worktree-unify-retrieval-pipeline`)

---

## 0. Evidence

- **Commit range**: `69adcb5..ffdbc6b` (9 commits)
- **Diff size**: +2598 / −1302 lines across 16 files. Source alone:
  `retrieval-policy.ts` +20 / −159, `search-notes.ts` −32, `types.ts` +8/−8.
- **Tasks done**: 35/35
- **Active hours**: ~1.5h wall-clock
- **Subagent dispatches**: 10 (4 implementer dispatches + 3 fix rounds via
  resume, 4 task reviews, 2 scoped re-reviews, 1 final whole-branch review)
- **New external dependencies**: none
- **Bugs encountered post-merge**: n/a — not yet merged
- **OpenSpec validate state at archive**: pass (10/10 items)
- **Test coverage signal**: vitest 977 passed / 78 files (was 945 / 78 at
  branch point — +32 net). `npx tsc --noEmit` and `npm run lint` clean.

Commit chain:

```
ebb16a3 docs(openspec): propose unify-retrieval-pipeline
36864b3 docs(openspec): fix three plan errata found in pre-flight
5dcae77 docs(openspec): record the findNeighbors ordering invariant the fold rests on
4cba619 docs(openspec): restructure the plan so every task ends green
6e91203 test(semantic): pin search_notes arity invariance through the SDK gate
23a0f3f fix(test): close arity-invariance blind spot in fallback and vacuous-field tests
dd482c0 refactor(semantic): fold executeRetrieval into the multi-query pipeline
52f89d4 docs(semantic): describe one retrieval pipeline, not two
ffdbc6b docs(semantic): restore embed-failure note dropped in the fold rewrite
```

---

## 1. Wins

- [evidence: `test/semantic/calibration-curve.test.ts` in `dd482c0`] The
  strongest behaviour-preservation evidence was **incidental, not designed**.
  The file holds full-precision inline snapshots of retrieval output. Stripping
  `"matched_queries":["q"],` from the two updated single-query snapshots yields
  a byte-identical diff against the pre-change versions, and the **multi-query
  snapshot required no change at all**. A pre-existing lock nobody wrote for
  this refactor turned out to prove more than the purpose-built harness did.

- [evidence: `6e91203` landing before `dd482c0`] Writing the MCP contract guard
  against the **unmodified two-pipeline code** and committing it first meant
  the tests could contradict the refactor rather than describe it. All four
  passed on the old code — which was the real finding: the contract did not
  already differ by arity, so the fold's premise held.

- [evidence: differential harness, Task 1] The gate failed on its first run and
  the failure was worth more than a pass would have been (see §5).

- [evidence: reviews of Tasks 1, 2, 3, 4] Every review found something the
  implementer and controller had both missed, and three of the four proved
  their finding by mutation rather than argument. The Task 2 reviewer disabled
  the single-query fallback retry and showed all four tests stayed green; the
  Task 3 reviewer mutated both contract gates and the added test.

- [evidence: `dd482c0`, 47 old `it`s → 34 parameterized ×2 + 7 arity-specific]
  Reorganizing the 1,305-line test file **strengthened** assertions rather than
  merely relocating them: mode-default checks went from one `NthCalledWith` to
  an exact call count plus every call's shape, and
  `does not run expansion when expansion is false` moved from `quick` (where
  expansion is off anyway — near-vacuous) to `deep`.

## 2. Misses

- 🟡 [painful | evidence: `36864b3`, `4cba619`] The plan needed two structural
  corrections after it was written. The first (three errata) was caught in
  pre-flight; the second was worse — Tasks 2/3/4/6 as originally drafted each
  left the tree uncompilable, so **none could carry its own test cycle or
  review gate**. That is not decomposition, it is the appearance of it. Caught
  only when preparing to dispatch, not when writing.

- 🟡 [painful | evidence: Task 1 review, Important finding] The differential
  harness I specified passed while proving very little: the mock ignored
  `threshold`, `limit`, `sources` and `queryVector`, so 4 of 7 cases entered
  their named branch and asserted `[] == []`. The branches it failed to cover
  (block backfill, key-dedup) are precisely the ones written differently in the
  two pipelines — the harness covered what was obviously identical and missed
  what carried the risk.

- 🟡 [painful | evidence: Task 2 review, Important finding] The characterization
  test named `fires identically at both arities` only called the array form.
  Both gaps above originate in briefs I wrote, not in implementer execution.

- 📌 [nit | evidence: Task 4 review, Important finding] A full rewrite of
  `docs/architecture/retrieval-policy.md` silently dropped a correct sentence
  about embed-failure bubbling to `DEPENDENCY_ERROR` — unrelated to the fold,
  collateral. Fixed in `ffdbc6b`.

- 📌 [nit | evidence: final review; `search-notes-hybrid.test.ts:844`] Spec
  scenario 4's tool-layer assertion `expect(asArray.truncated).toBe(asString.truncated)`
  is vacuous — both are `false` in that fixture. The behaviour is genuinely
  pinned at `retrieval-policy.test.ts:831`, so the requirement holds, but the
  MCP-level assertion looks like coverage it does not provide. Follow-up.

## 3. Plan deviations

| Plan task            | What changed                                                                                       | Why                                                                                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks 2+3+4+6 → 3    | Merged into one atomic "The fold" task                                                             | Each left the tree uncompilable; a task that cannot be tested cannot be reviewed. Four consecutive ungated tasks would have shipped the core change with no per-task review.     |
| Task 5 → Task 2      | Contract tests promoted ahead of the fold, rewritten as characterization tests against current code | Tests written after a refactor can only confirm it; written before, they can contradict it.                                                                                     |
| Task 1 fixture       | Tie-break case rewritten to feed engine-ordered input                                              | The original fed a mock order the real `findNeighbors` provably cannot return. Correcting a contract-violating **input** ≠ weakening an **assertion** (see §5).                  |
| Task 3 commit scope  | 6 files, not the 4 I ruled                                                                         | `calibration-curve.test.ts` and `rank-fusion.test.ts` reference the deleted names; excluding them leaves the tree red. My ruling was based on incomplete information.            |
| Task 3 test count    | One test **added** (`every result carries matched_queries`)                                        | Nothing else fails if the widened field is left unset for a single query. Reviewer mutation-confirmed it is the only guard.                                                      |
| Task 5 ordering      | Acceptance checks → final review → PR, instead of PR inside Task 5                                 | SDD requires the whole-branch review before finishing; a review after the PR is open cannot influence what a human reviewer first sees.                                          |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓    |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓    |
| (transitive) superpowers:requesting-code-review  | ✓    |
| superpowers:finishing-a-development-branch       | ✓    |

### Deliberately Skipped Skills

None. All apply-phase skills were used.

One adaptation worth recording rather than a skip: **Task 1's review was
file-based, not diff-based.** Task 1 produces no commit by design (the
differential harness is git-excluded scaffolding, deleted in Task 3), so
`review-package` would have produced an empty diff. The reviewer was given the
two scratch file paths directly. The gate still ran; only its input format
changed.

## 5. Surprises

- **The differential gate failed on its first run, and the failure was a bad
  fixture rather than a code gap — but proving that surfaced a load-bearing
  invariant nobody had written down.** The fold is only sound because
  `findNeighbors` returns results *already sorted* by the same total order
  `mergeNoteResults` re-applies (`search-engine.ts:89`, comparator `:22-28`),
  and because paths are unique, making it a **strict** total order and the
  re-sort idempotent. My design asserted the comparators matched; it never
  stated the dependency on the engine sorting at all. Now recorded in
  `design.md` §"The load-bearing invariant" and in
  `docs/architecture/retrieval-policy.md`, cross-referenced to
  `search-engine.test.ts:61`, which pins it.

- **The implementing subagent's root-cause analysis was confidently wrong**, and
  so were both remedies it proposed ("accept the behaviour change" / "bypass the
  merge sort at n=1"). Neither applied: there was no production behaviour change
  to accept, and the bypass would have added a branch to preserve a behaviour
  only a contract-violating mock can observe. A thorough, well-evidenced report
  can still reach the wrong conclusion — the evidence has to be re-derived, not
  audited for internal consistency.

- **Subagents corrected me three times**, all verified and all right: two line
  numbers in a brief (`search-engine.ts:107,109`, not `:108-110`), an
  undercounted recon list, and the six-file commit scope. Recon handed to a
  subagent must be labelled as a starting map, not as truth.

- **The most dangerous edit in this change looks like tidying.** After the fold
  every node carries `matched_queries`, so the `isMulti ? … : undefined` gate in
  `assembleUnified` reads as leftover scaffolding. Deleting it is the natural
  "finish the job" move and it silently breaks the MCP contract. Pre-mutating it
  and putting the exact failure message in the brief was what prevented it.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **A test that has never been observed to fail is not yet a test — mutate the code and watch it go red before trusting a green gate.** → **Promote to memory** (type: feedback)
  > **Why**: In this cycle a green differential harness was proven under-powered (4 of 7 cases asserted `[] == []`), and a green characterization suite was proven blind to single-arity regressions — both only after someone deliberately broke the code. Green tells you nothing about whether a test can discriminate.
  > **How to apply**: Whenever a test is the gate licensing a deletion or refactor, break the specific behaviour it claims to cover, confirm RED, revert, confirm GREEN — and require the implementer to report both observations, not just the final green.

- [ ] 🔴 **Every task in a plan must end with a green, committable tree.** → **Promote to memory** (type: feedback)
  > **Why**: The first draft split the fold into four tasks that each left the tree uncompilable. Each looked like a clean unit but none could run tests or receive a diff review, so the core change would have landed through four consecutive ungated steps.
  > **How to apply**: When decomposing a refactor, ask of each task "does this compile and pass tests on its own?" If not, it is not a task — merge it with its neighbours. Applies at plan-writing time, before any dispatch.

- [ ] 🟡 **Write contract/characterization tests against the unmodified code and commit them before the change.** → **Promote to memory** (type: feedback)
  > **Why**: Tests written after a refactor can only confirm whatever the new code does. Committed first, they retain the power to contradict it — and here their passing on the *old* code was itself the finding that validated the refactor's premise.
  > **How to apply**: Any behaviour-preserving refactor. Land the guard as its own commit before touching the code it guards; if the guard fails on current code, stop — the premise is wrong.

- [ ] 🟡 **Recon handed to a subagent is a starting map, not truth — say so explicitly in the brief.** → **Promote to memory** (type: feedback)
  > **Why**: Controller recon in this cycle contained two wrong line numbers and an undercounted file list. Subagents caught all of them only because the brief said the recon might be wrong and required grepping before asserting.
  > **How to apply**: In every dispatch containing controller-gathered findings, label them explicitly as unverified and require independent confirmation before the subagent asserts them in code or docs.

- [ ] 🟡 **In a full-file rewrite, diff for substance, not wording — deletions inside a rewrite look like part of the rewrite.** → **Promote to memory** (type: feedback)
  > **Why**: The `retrieval-policy.md` rewrite silently dropped a correct, still-relevant sentence about embed-failure error mapping that had nothing to do with the refactor. A diff review reads the whole block as replaced and waves it through.
  > **How to apply**: When a doc or module is rewritten wholesale rather than edited, enumerate what the old version asserted and confirm each claim is either carried forward or deliberately superseded.

- [ ] 📌 **Correcting a fixture that violates a real interface's contract is not the same as weakening an assertion.** → **One-off** (recorded, not promoted)
  > **Why**: The tie-break case fed a mock ordering the real `findNeighbors` provably cannot produce. Fixing the input was legitimate; the superficially similar move — relaxing the assertion — was explicitly forbidden in the same cycle.
  > **How to apply**: Doesn't generalize cleanly; the distinction is real but requires knowing the producer's contract, so it is a judgement call rather than a rule.

- [ ] 📌 **Follow-up: spec scenario 4's tool-layer `truncated` comparison is vacuous.** → **One-off** (follow-up work item)
  > **Why**: `search-notes-hybrid.test.ts:844` compares `truncated` between arities in a fixture where both are `false`. The behaviour is pinned at `retrieval-policy.test.ts:831`, so the requirement holds, but the MCP-level assertion advertises coverage it does not provide.
  > **How to apply**: Give it a truncating fixture or delete it; do not leave an assertion that cannot fail.

- [ ] 📌 **Follow-up: `retrieval-policy.ts:251`'s max-across-query-vectors backfill has no test that picks the larger hit.** → **One-off** (already spawned as a separate task)
  > **Why**: Pre-existing, not introduced here — the final review confirmed the surviving block is textually the old multi-query backfill and that at n=1 the comparison is unreachable. Existing tests use one vector and a constant mock, so `>` could be swapped for `<` with the suite still green.
  > **How to apply**: Separate PR; two queries with genuinely different vectors and different per-vector block similarities, mutation-verified.
