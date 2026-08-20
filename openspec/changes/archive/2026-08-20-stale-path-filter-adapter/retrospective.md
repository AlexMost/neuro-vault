# Retrospective: stale-path-filter-adapter

> Written: 2026-08-20 (after verify passed)
> Commit range: `6fb1521..0de52bf`
> Worktree: `.claude/worktrees/stale-path-filter-adapter` on `worktree-stale-path-filter-adapter`

---

## 0. Evidence

- **Commit range**: `6fb1521..0de52bf` (10 commits, `origin/main..HEAD`)
- **Diff size**: +1366 / −65 across 27 files. Split: `src/` +66/−57 across 7 files; `test/` +158/−6 across 10 files; the remainder is the change's own 8 artifacts.
- **Tasks done**: 17/17 in tasks.md; 44/44 steps in plan.md
- **Active hours**: ~0.6h wall clock (13:04 propose → 13:36 retrospective, including artifact authoring)
- **Subagent dispatches**: 0 — see §4
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (not merged at write-time)
- **OpenSpec validate state at archive**: pass (10 passed / 0 failed)
- **Test coverage signal**: vitest 945 → 953 (+8), 78 → 79 files, 0 failures

Commit chain (時序):

```
6fb1521 docs(openspec): add stale-path-filter-adapter change artifacts
1b80154 feat(obsidian): add per-vault existing-path filter
b16ddb3 feat(registry): expose filterExisting as a per-vault capability
3f68846 test(registry): default filterExisting to the real disk filter
21e4954 refactor(semantic): find_duplicates uses entry.filterExisting
797e958 refactor(semantic): search_notes uses entry.filterExisting
f52fe67 refactor(semantic): get_similar_notes uses entry.filterExisting
b735cb0 refactor(semantic): drop pathExistsForEntry, the adapter owns existence
4765e59 docs: record the staleness obligation and its single owner
0de52bf chore(openspec): mark stale-path-filter-adapter tasks complete
```

---

## 1. Wins

- The "land the adapter first, migrate call sites after" sequencing (design §Migration Plan) meant `3f68846` was a provable no-op: the rig default went in while all three private copies still stood, and the suite stayed at 951/951. Every later failure was therefore unambiguously about the call site being moved, not about the seam.
- Migrating call sites smallest-first paid off. `find_duplicates` (`21e4954`) is 4 lines of real change; getting it green validated the whole seam before `search_notes` (`797e958`) and the interleaved `get_similar_notes` (`f52fe67`) were touched.
- Two of the three call-site commits changed **only** the source file — `git status` showed no test file touched. That is the strongest available evidence that behaviour did not move: the pre-existing staleness assertions passed untouched on both sides of the edit.
- The pre-commit hook (eslint + prettier) caught a formatting drift at `f52fe67` before it landed, and the commit simply did not happen. Cheap gate, zero cleanup commit.
- Writing the plan with the _exact_ replacement code inline (Task 1 §Step 3, Task 6 §Step 4) made apply near-mechanical. No step required re-deriving a decision that design.md had already made.

## 2. Misses

- 🟡 [painful | evidence: `b16ddb3`] The plan predicted `makeTestRegistry` would absorb the required-field break by itself. It did not: four `IVaultEntry` object literals live outside it (`operations-module.test.ts:37`, `corpus-refresh.integration.test.ts:85`, and two in `server-instructions.test.ts`). `tsc --noEmit` found all four in one pass, so the cost was ~5 minutes, but the plan's Task 2 §Step 6 said "expect zero errors" and that was wrong. A `grep -c ': IVaultEntry = {'` during planning would have predicted it exactly.
- 📌 [nit | evidence: `4765e59`] `docs/architecture/retrieval-policy.md:154` described existence filtering via a `pathExists` predicate "defaulted in `src/modules/semantic/index.ts`". That file has no such predicate and had none before this change — the doc had been stale independently of this work. Found only because the Task 8 §Step 3 sweep grepped for the concept rather than for the files this change touched.
- 📌 [nit | evidence: `b735cb0`] A test in `find-duplicates.test.ts` was named "…(using mock pathExists)" while actually provisioning a real temp directory. Renamed in passing; it had been misleading since before this change.

## 3. Plan deviations

| Plan task      | What changed                                                                                                                                                        | Why                                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task 2 §Step 6 | Expected zero type errors outside `makeTestRegistry`; got four literal sites needing `filterExisting`. Each was given the real filter bound to its own path rather than a permissive stub. | The plan surveyed `makeTestRegistry` but never enumerated direct `IVaultEntry` literals. Stubbing them permissive would have silently disabled the filter in the corpus-refresh integration test, which does exercise search. |
| Task 8 §Step 3 | Sweep found and fixed `retrieval-policy.md`, which the plan had not named as an affected doc.                                                                        | The plan listed the two docs the change _adds_ concepts to; the sweep is what catches docs that describe the concept elsewhere. Working as designed — the deviation is that the plan's Impact list was incomplete, not that the sweep failed. |
| Task 7 §Step 3 | Added a `find_duplicates` test-name fix not in the plan.                                                                                                            | Same family as the comment updates the step did call for: a stale reference to the deleted helper.                                                                                                                                              |

## 4. Skill / workflow compliance

| Skill                                            | Used                 |
| ------------------------------------------------ | -------------------- |
| superpowers:brainstorming                        | ✓                    |
| superpowers:writing-plans                        | ✓                    |
| superpowers:using-git-worktrees                  | ✓                    |
| superpowers:subagent-driven-development          | ✗                    |
| (transitive) superpowers:test-driven-development | ✓ (applied manually) |
| (transitive) superpowers:requesting-code-review  | ✗                    |
| superpowers:finishing-a-development-branch       | ✓                    |

### Deliberately Skipped Skills

- **`superpowers:subagent-driven-development`** (and transitively `superpowers:requesting-code-review`)
  - **What was skipped**: the entire executor. All 9 plan tasks were implemented inline by the main loop; no per-task subagent and no per-task code-reviewer subagent were dispatched. The final whole-diff review was likewise not dispatched.
  - **Why this cycle**: the session's system prompt carries a hard constraint — "Do not call the AgentTool unless the user requested it" — which directly contradicts this schema's apply instruction ("do NOT silently fall back to manual implementation"). Rather than resolve it silently in either direction, the conflict was surfaced to the user before any file was touched, and the user selected "Manual apply, inline" from an explicit three-option prompt. That selection is the schema's documented opt-in for the manual fallback path. TDD was still honoured per-task by hand: RED verified before GREEN at Task 1 (`existing-paths.test.ts` failed on missing module) and Task 2 (`vault-registry.test.ts` 1 failed / 11 passed), and every call-site migration ran its pre-existing guard test green before the edit.
  - **How to prevent recurrence**: `CLAUDE.md trigger`. Add to `.claude/rules/opsx-routing.md` a short "Apply executor" note: when a session's harness config forbids the Agent tool, `/opsx:apply` must surface the conflict and obtain an explicit user choice before the first edit, and record the choice in verify.md's Verifier line and here in §4. This makes the escape hatch a documented one-question branch rather than an ad-hoc judgment call each cycle, and keeps the audit trail (who authorised the fallback, when) in the artifacts. The residual gap is real and worth naming: no independent reviewer looked at this diff. Mitigations actually in place were the four gates, the untouched-test-file evidence in §1, and the explicit single-implementation grep at Task 7 §Step 5 — not a substitute for review, but not nothing.

## 5. Surprises

- **The refactor is not a net deletion.** `src/` moved +66/−57 — nine lines _added_. The architecture review filed this as "one adapter for a concept implemented three times" and it is, but the collapse of three ~11-line copies into one implementation is roughly offset by the adapter's doc comment and its injectable `access` seam. The win here is locality, substitutability, and a discoverable name on the entry — not line count. Worth remembering when reading the same review's candidate 1, which _does_ promise ~150–180 deleted lines: these two candidates pay off in different currencies.
- **`ADR-0006` does not say what the review said it says.** The review asserted the ADR "makes existence-checking a permanent obligation of every corpus consumer." Reading it during brainstorm showed the obligation is a consequence of the read-only/unwatched decision, not a clause. Cost of checking: one file read. Cost of not checking: an artifact citing an ADR clause that does not exist, propagated into `smart-connections-corpus.md` where the next reader would trust it.
- **The empty scaffolds skewed `openspec validate` counts.** Main reports 11 items, the worktree 10, because `unify-retrieval-pipeline` and `multi-vault-dispatch-builder` are untracked scaffolds on `main` that no worktree branched from `origin/main` can see. Momentarily looked like a regression; noted in verify.md §1 so the next reader does not re-investigate.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Adding a required field to `IVaultEntry` breaks literals outside `makeTestRegistry`** — four test files construct `IVaultEntry` object literals directly, so any new required field costs four extra edits beyond the shared rig.
  > **Why**: The rig defaults (`semanticAvailable`, `reader`, `readConventions`, now `filterExisting`) create a false impression that all test entries flow through one constructor. They do not, and `tsc` is the only thing that finds the rest.
  > **How to apply**: Before adding a required field to `IVaultEntry`, run `grep -rn ': IVaultEntry = {' test` and add the four sites to the plan's task list. Bind the new field to the entry's own `path` rather than stubbing it permissive — `corpus-refresh.integration.test.ts` genuinely exercises the filtered path.

- [ ] 🟡 **When harness config forbids the Agent tool, `/opsx:apply` must ask before editing, not decide** — the superpowers-bridge apply phase mandates subagent-driven-development, and some sessions forbid it; the collision is a user decision, surfaced before the first file changes.
  > **Why**: Silently falling back strips TDD enforcement and per-task code review with no audit trail; silently refusing strands a ready change. The schema itself names the manual path as an explicit opt-in, so the only compliant move is to ask.
  > **How to apply**: At `/opsx:apply` start, after the pre-flight skill check, compare the schema's required executor against the session's tool constraints. On conflict, present the options and record the answer in verify.md's Verifier line and retrospective §4.

- [ ] 📌 **Doc sweeps should grep the concept, not the touched files** — `retrieval-policy.md` had described a `pathExists` predicate in a file that never had one; only a concept-wide grep surfaced it.
  > **Why**: A change's Impact list names docs that gain the concept. Docs that _already describe_ it elsewhere — accurately or not — are invisible to that list, and stale mechanism prose is exactly what ADR-0008's living-docs rule exists to prevent.
  > **How to apply**: In any change that moves where a mechanism lives, grep `docs/` for the mechanism's old symbol names and its plain-English phrasing, then verify each hit against the code before rewriting. Extends the existing "sweep all of docs/, including docs/guide" rule with "and grep for the concept, not just the files you touched."

- [x] 📌 **Verify code claims in a durable doc before repeating them** — the review's ADR-0006 citation did not survive reading the ADR.
  > **Why**: Already captured as an existing memory (`verify-code-claims-in-durable-docs`); this cycle is a second confirming instance, not a new lesson.
  > **How to apply**: No new action — memory already exists and fired correctly here.
