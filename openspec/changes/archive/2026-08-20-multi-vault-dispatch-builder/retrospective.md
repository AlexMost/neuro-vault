# Retrospective: multi-vault-dispatch-builder

> Written: 2026-08-20 (after verify passed with warnings, none blocking)
> Commit range: `69adcb5..9de5d66`
> Worktree: `.claude/worktrees/multi-vault-dispatch-builder` (branch `worktree-multi-vault-dispatch-builder`)

---

## 0. Evidence

- **Commit range**: `69adcb5..9de5d66` (20 commits)
- **Diff size**: +2535 / −161 across 26 files. By area: `src/` +186/−153 (8 files) · `test/` +442/−4 (8 files) · `docs/` + `README.md` +43/−4 (3 files) · `openspec/` the remainder (artifacts)
- **Tasks done**: 26/26
- **Active hours**: ~2.2h wall-clock
- **Subagent dispatches**: 22 (11 implementer dispatches incl. 5 fix rounds, 11 reviewer dispatches incl. 4 scoped re-reviews and 1 whole-branch review)
- **New external dependencies**: none (`git diff package.json` empty)
- **Bugs encountered post-merge**: n/a — not yet merged
- **OpenSpec validate state at archive**: pass (10/10 items)
- **Test coverage signal**: vitest 945 → 977 tests (+32), 78 → 81 files

Commit chain:

```
97bb132 docs(openspec): add multi-vault-dispatch-builder change artifacts
e0fcbdb feat(lib): add FAN_OUT_SUFFIX as the single copy of the fan-out prose
4ab8b1b feat(lib): add buildMultiVaultTool owning the fan-out dispatch contract
c5afd26 fix(lib): forbid vault in multi-vault tool inputShape at the type level
226294e refactor(tools): build list_tags through buildMultiVaultTool
fdadda6 refactor(tools): build list_properties through buildMultiVaultTool
467e6f0 refactor(tools): build query_notes through buildMultiVaultTool
a588f4a refactor(tools): build get_vault_overview through buildMultiVaultTool
4288d0e docs(openspec): reconcile tasks.md with plan.md and check off migrations
1d25be4 refactor(tools): build search_notes through buildMultiVaultTool
8d12f82 fix(tools): fix search_notes description separator and test duplication
f19ee3c test: assert the fan-out prose has exactly one copy across all five tools
2bab843 test: catch a sixth hand-written fan-out tool via envelope wording
ebd2d54 refactor(lib): relax IFanOutResult to T extends object
63b148c docs(architecture): document buildMultiVaultTool as the fan-out entry point
219b699 docs(architecture): document the multi-vault separator rule and fix imprecise "only"
892ee37 docs(openspec): check off all task groups
185c8ef docs: correct the drift description in the builder comment and proposal
f327eec docs(readme): stop promising skipped_vaults semantics fan-out never delivers
9de5d66 docs(readme): list all five fan-out tools in the documentation callout
```

---

## 1. Wins

- [evidence: whole-branch review, §0 26 files] **The behaviour-preservation claim was verified mechanically, not by reading.** The final reviewer rebuilt all 14 tools at base and at head in both single- and multi-vault mode and diffed name / title / description / JSON-Schema. Result: all 14 input schemas byte-identical, titles identical, ordering identical; exactly the 5 fan-out descriptions changed, each only in the tail. For a refactor whose entire value rests on "nothing else moved", this is the difference between a claim and a fact.
- [evidence: `f19ee3c`, `2bab843`, `test/lib/fan-out-prose.test.ts`] **The drift guard survived an adversarial check and got stronger.** A reviewer ran 9 mutations, including restoring the literal pre-refactor `list_tags` and `get_vault_overview` sources — both failed the test, so it catches the actual historical bug, not a strawman.
- [evidence: `ebd2d54`, +13/−23] **The contingent hypothesis (design D4) held.** Isolating it as its own task meant a clean typecheck was unambiguous evidence rather than a coincidence, and the documented fallback was never needed.
- [evidence: `c5afd26`, `test/lib/multi-vault-tool.test.ts` `@ts-expect-error`] **A review finding became a compile-time guarantee.** `inputShape: z.ZodRawShape & { vault?: never }` turned "the builder owns `vault`" from a convention into a typecheck error. Task 10's reviewer later re-verified the guard was still active under the widened bound rather than silently vacuous — exactly the regression that would otherwise have gone unnoticed.
- [evidence: `docs/architecture/smart-connections-corpus.md`, `f327eec`] **The change fixed two instances of its own bug class that predated it.** The false `skipped_vaults` story lived in the architecture docs and in README, not just in tool descriptions.

## 2. Misses

- 🟡 [painful | evidence: `f327eec`, `9de5d66`, verify §Overall warning 1] **The doc sweep missed `README.md` because it grepped `docs/` only.** README carried the identical false `skipped_vaults` claim the change exists to remove, and contradicted itself two lines later. Caught by the verify phase via the repo rule about user-facing references — one phase later than it should have been.
- 🟡 [painful | evidence: `4288d0e`] **`tasks.md` contradicted `plan.md`.** Groups 2.1/2.3/2.4 said to delete the type aliases during migration; `plan.md` group 5 deferred that to the isolated experiment. Implementers followed the plan correctly, but a subagent reading only `tasks.md` would have broken the D4 attribution. Both were written in the same session and should have agreed.
- 🟡 [painful | evidence: `8d12f82`, plan.md Task 8 Step 3] **A plan step gave a rationale that did not hold.** The trailing `''` was specified "so the join leaves a blank line" — it does not; it yields one newline against `describeMultiVault`'s leading space. Escalated to the human partner, who chose a builder-level separator rule that fixed the root cause instead of the symptom.
- 📌 [nit | evidence: task-9 report, plan.md Task 9 Step 3] **A mutation check in the plan was logically impossible to pass.** It asked to mutate `FAN_OUT_SUFFIX` and expect failure, but the test imports the constant, so both sides of the assertion move together. The implementer caught it and substituted a valid mutation rather than reporting a meaningless green.
- 📌 [nit | evidence: `185c8ef`] **Durable comments carried unverified counts.** "three variants, two of them describing `skipped_vaults`" was wrong (one of three, carried by two tools) and "all five carried `& Record<string, unknown>`" was wrong (four of five). Written from memory of the review report rather than from the source.
- 📌 [nit | evidence: plan.md Task 12 Step 3] **A verification expectation was miscalibrated.** It predicted "exactly one hit" for `registry.isMulti()` in `src/modules/`; there are two — the second is MCP *resources*, a different concept never in scope.

## 3. Plan deviations

| Plan task     | What changed                                                                                | Why                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task 7        | No commit produced; folded into controller verification                                     | Tasks 3–6 had already updated every description assertion as they migrated. A grep over `test/ src/ docs/` confirmed nothing stale remained.            |
| Task 8        | Trailing `''` replaced by a builder-level separator rule                                     | The plan's stated rationale was wrong. Human partner chose the root-cause fix, which also removed a dangling newline in single-vault mode.              |
| Task 9        | Added a list-independent envelope assertion beyond the plan's scope                          | Review identified a hand-written sixth tool as "the most likely recurrence path"; without it, the proposal's "cannot recur" claim was overstated.       |
| Task 11       | Extended to document the separator rule                                                      | The rule postdated the plan. Omitting it would leave a sixth-tool author to rediscover the spacing behaviour.                                           |
| Task 12       | Run by the controller rather than dispatched                                                 | Pure verification commands, no artifact produced. Dispatching would have re-derived facts already in hand.                                              |
| (unplanned)   | Two README commits during verify                                                             | Verify-phase defect; see §2.                                                                                                                            |

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

(none — every apply-phase skill was used)

## 5. Surprises

- **The drift guard is less circular than it first appears.** Mutating `FAN_OUT_SUFFIX` leaves the test green, which reads like circularity. But re-adding the `skipped_vaults` clause *inside* the constant still fails, because `not.toContain('skipped_vaults')` is a hardcoded literal anchor. Neither the implementer nor I spotted this — the reviewer's mutation matrix did.
- **`T extends object` worked on the first attempt.** The plan hedged heavily and specified a fallback. TypeScript's generic object spread accepted it cleanly at all five call sites.
- **A sibling change's justification did not survive checking.** The in-flight `stale-path-filter-adapter` change asserts "ADRs are immutable (ADR-0008)". ADR-0008 says no such thing — it establishes the living-vs-durable layer split, and the Status-change carve-out is in `docs/adr/INDEX.md`. Same conclusion, different warrant. Inheriting the citation unverified would have propagated a false claim about our own process docs.
- **`search_notes` was the first block-structured description to hit the builder**, which is why the separator bug existed at all. The other four are single paragraphs, so `describeMultiVault`'s leading space had always been correct until this change gave them a shared owner.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Doc sweeps must include repo-root files, not just `docs/`** → **Promote to memory** (type: feedback)
  > **Why**: This cycle's Task 11 swept `docs/` thoroughly — including `docs/guide/`, which a prior memory already warned about — and still shipped a false claim in `README.md`, the single most-read file in the repo. The existing memory said "sweep all of docs/"; the gap was that README is not under `docs/`.
  > **How to apply**: When a change alters a user-visible contract (tool description, response shape, CLI flag), grep `README.md` and every `*.md` at the repo root alongside `docs/`. Extends the existing [[feedback_doc_sweep_scope]] memory rather than replacing it.

- [ ] 🟡 **`tasks.md` and `plan.md` must be reconciled before apply starts** → **Promote to memory** (type: feedback)
  > **Why**: They were written minutes apart in the same session and still disagreed about when to delete the type aliases (`4288d0e`). A subagent reading only its brief would have destroyed the D4 attribution the plan deliberately engineered.
  > **How to apply**: At the end of `/opsx:propose`, diff the two artifacts for contradicting instructions on the same file or symbol before declaring the change apply-ready.

- [ ] 📌 **Never write a count into a durable comment without grepping first** → **Promote to memory** (type: feedback)
  > **Why**: "three variants, two of them…" and "all five tools carried…" were both wrong (`185c8ef`), written from a review summary rather than source. Reinforces [[feedback_verify_code_claims_in_durable_docs]] with a concrete second instance — the first was an ADR.
  > **How to apply**: Before writing "all N", "two of the three", or any tally into a comment, ADR, or proposal, run the grep that establishes it and paste the result into the report.

- [ ] 🟡 **A plan step's stated rationale is a claim that needs checking, not just its instruction** → **Promote to schema** (superpowers-bridge `plan` artifact instruction)
  > **Why**: Two plan steps this cycle carried instructions that were fine but rationales that were false — the `''` blank line (Task 8) and the `FAN_OUT_SUFFIX` mutation (Task 9). Both were caught only because implementers reasoned about the *why* instead of mechanically following the *what*.
  > **How to apply**: `writing-plans` self-review should verify each step's stated rationale, not only that the step has concrete content. An implementer told "do X so that Y" should report when X does not produce Y.

- [ ] 📌 **Isolating a contingent hypothesis into its own task paid off** → **One-off** (record only)
  > **Why**: Task 10 tested a compiler hypothesis with both outcomes specified in advance. Because nothing else changed in that commit, the clean typecheck was unambiguous. Worth remembering as a pattern, but it does not generalise into a rule — most tasks are not experiments.

- [ ] 📌 **Verify-phase repo rules earn their keep** → **One-off** (record only)
  > **Why**: The rule "if a change touches a tool description, confirm README/docs/guide is updated in the same change" is what caught the README defect, after a dedicated doc-sweep task had already run and passed review. A checklist item outperformed a whole task.
