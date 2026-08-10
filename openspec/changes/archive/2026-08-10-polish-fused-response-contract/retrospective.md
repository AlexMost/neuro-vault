# Retrospective: polish-fused-response-contract

> Written: 2026-08-10 (after verify passed)
> Commit range: `480e286..c6a9f42`
> Worktree: `.claude/worktrees/polish-fused-response-contract` (branch `worktree-polish-fused-response-contract`)

---

## 0. Evidence

- **Commit range**: `480e286..c6a9f42` (9 commits)
- **Diff size**: +1425 / -38 lines across 19 files
- **Tasks done**: 10/11 at verify time (`tasks.md`; 4.3 PR = schema-final step, ticked at finishing)
- **Active hours**: ~1.5 (single session: propose → apply → verify)
- **Subagent dispatches**: 14 + 1 resume (6 implementers, 1 mid-branch fixer, 1 final fixer; 5 task reviewers + 1 re-review, 1 whole-branch reviewer + 1 resumed re-review)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (pre-merge; branch not yet merged at write time)
- **OpenSpec validate state at archive**: pass (9/9, `--json` all valid)
- **Test coverage signal**: vitest 872 → 885 tests (13 net new), full suite green at every task commit
- **Verification gates**: `npm test` / `lint` / `typecheck` / `build` / `openspec validate --all` all green at c6a9f42

Commit chain (時序):

```
b6c1bf4 docs(openspec): add polish-fused-response-contract change artifacts
bfb1406 feat(lexical): report per-token note counts for AND-killed queries
bb34f14 fix(lexical): count each note once per token when a query repeats tokens
91a01a3 feat(lexical): expose perQueryTokenCounts from LexicalIndex.search
d540c4b feat(semantic): backfill best block for seeds starved by the shared block pass
cfaf90a feat(search)!: honest query_stats (null semantic, lexical_tokens) and no empty blocks
5b50fed docs: describe backfilled block evidence, null semantic stats, lexical_tokens
fe359de docs(openspec): tick implemented tasks for polish-fused-response-contract
c6a9f42 fix(search): scope lexical_tokens promise to an executed lexical leg; docs and test polish
```

---

## 1. Wins

- [evidence: bb34f14] Task-level adversarial review caught a real bug in the plan's own suggested code (duplicate normalized tokens double-counting notes) before it shipped — the reviewer labeled it plan-mandated instead of waving it through because "the plan said so".
- [evidence: cfaf90a, task-4-report] The Task 4 implementer caught a factual error in the plan (a `mode: 'lexical'` test mislabeled as hybrid at "line ~489/531") and resolved it by contract semantics rather than following stale line numbers.
- [evidence: c6a9f42] The whole-branch final review earned its keep beyond per-task gates: it found a normative-spec over-promise (`lexical_tokens` SHALL on the empty-filter path where the lexical leg never runs) and a docs misexplanation (all-non-zero `lexical_tokens` is reachable because AND is per-unit while the diagnostic counts any-unit) that no task-scoped review could see.
- [evidence: §0 commit chain] Bottom-up task ordering (rank.ts → lexical-index → retrieval-policy → tool layer → docs) meant every commit was green on the full suite; no cross-task rework.
- [evidence: task-3-report] Backfill landed with zero pre-existing test modifications — the implementer audited every `findBlockNeighbors` mock before claiming so, and the reviewer independently re-verified the claim.

## 2. Misses

- 🟡 [painful | evidence: bfb1406→bb34f14, c6a9f42] Two of the three defects found by reviews originated in the *plan's own verbatim code/spec text* (dup-token counting; unconditional `lexical_tokens` SHALL). Complete-code plans transcribe fast but also transcribe their bugs — the plan author (me) never ran the code.
- 📌 [nit | evidence: task-4-brief vs file] The plan cited line numbers (~489/531) that drifted from the actual file, and used a `runSearch` placeholder for a helper idiom that doesn't exist in the target test file — both burned implementer time resolving ambiguity.
- 📌 [nit | evidence: stale-LSP diagnostics during Tasks 1/2/4] IDE diagnostics repeatedly flagged "property does not exist" in the worktree; all were stale-LSP noise, as predicted by the existing `feedback_worktree_stale_lsp` memory. No time lost — the memory worked.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 1 | +1 fix commit (token dedup) beyond plan code | Plan's suggested loop double-counted repeated tokens; reviewer caught it |
| Task 4 | One "keep `semantic: 0`" instruction inverted to `null` | The referenced test was actually `mode: 'lexical'` (degradation path); plan line numbers were stale |
| Task 5 | Step 4 (push + PR) deferred out of the task | Schema orders PR last (after verify → retrospective → archive); tasks.md 4.3 ticked at finishing |
| (post-plan) | Final-review fix commit c6a9f42 | Spec/description/docs wording scoped to "lexical leg executed"; docs all-non-zero explanation; test call-count pin |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ (native EnterWorktree) |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN evidence in every task report) |
| (transitive) superpowers:requesting-code-review  | ✓ (per-task + whole-branch) |
| superpowers:finishing-a-development-branch       | ✓ (next step after archive) |

### Deliberately Skipped Skills

(none — all apply-phase skills used)

## 5. Surprises

- The lexical AND-kill diagnostic has a third outcome nobody designed for: **all tokens non-zero** with `lexical: 0` (tokens co-exist in a note but never within one title/heading/paragraph unit). The design only discussed "a zero names the killer token". The final reviewer derived it from `matchUnit`'s per-unit semantics; docs now explain it with the correct remediation (split the query into an array).
- The empty-filter early return is a *third* degradation class: neither leg runs, yet `lexical: 0` remains an honest count over an empty set while `semantic` must be `null` — and `lexical_tokens` must NOT appear. The original delta spec missed this interaction of two features authored in the same change.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Plan-embedded code is unexecuted code — review it like a diff before apply** → **Promote to** memory (type: feedback)
  > **Why**: Both substantive defects this cycle (bb34f14 dup-token count; c6a9f42 spec over-promise) were transcribed verbatim from plan.md, authored without execution. The per-task reviewer caught one only because it was told the contract, not the code, is authoritative.
  > **How to apply**: When writing plans with complete code (writing-plans skill), run a self-review pass that treats each embedded code block as a reviewable diff (edge inputs: duplicates, empty sets, unicode); when dispatching task reviewers, always state the contract in the constraints block so plan code doesn't self-grade.

- [ ] 📌 **Cross-feature interaction scenarios belong in the delta spec** → **One-off** (記錄即可,不 promote)
  > **Why**: The `semantic: null` (feature 1) × `lexical_tokens` (feature 3) interaction on the empty-filter path was missed because each requirement was written against its own feature; caught only at whole-branch review.
  > **How to apply**: Doesn't generalize into a rule cheaply — noting that multi-feature changes deserve one "features × degradation paths" pass during spec authoring.

- [ ] 📌 **Plan line-number references go stale; prefer anchors** → **One-off**
  > **Why**: Task 4's "~line 489/531" pointed at the wrong test after earlier tasks shifted the file; the implementer recovered by reading semantics.
  > **How to apply**: In plans, cite test names/describe blocks instead of line numbers for files earlier tasks will touch.
