# Retrospective: search-notes-unified-rank

> Written: 2026-08-08 (after verify passed)
> Commit range: `a2604ed..17ff53a`
> Worktree: /Users/amostovenko/git/neuro-vault/.claude/worktrees/search-notes-unified-rank

---

## 0. Evidence

- **Commit range**: `a2604ed..17ff53a` (18 commits)
- **Diff size**: +2355 / −413 lines across 29 files
- **Tasks done**: 11/11 (`grep -cE '^\s*- \[x\]' tasks.md` → 11)
- **Active hours**: ~4–5 (single session, explore → propose → apply)
- **Subagent dispatches**: 18 fresh agents + ~10 resumed continuations (5 implementers, 2 spot fixers, 8 task reviewers incl. re-reviews, 1 final whole-branch reviewer on the most capable model)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (not merged yet at write time)
- **OpenSpec validate state at archive**: pass (9/9 items valid)
- **Test coverage signal**: vitest 848 tests / 73 files (was 819/72 at branch base; +29 tests), lint + `tsc --noEmit` clean

Commit chain (chronological):

```
3df4d5a docs(openspec): add search-notes-unified-rank change artifacts
21d1041 feat(lexical): expose per-query pre-cap counts and vault note total
ccaa01e test(lexical): cover per-query pre-cap counts and totalNotes
c4efcbe feat(semantic): expose per-query pre-merge hit counts from multi retrieval
be0cb55 test(semantic): cover per-query hits surviving the cross-query cap
9223691 feat(semantic): add RRF rank-fusion module with adaptive k and expansion flattening
92b241e test(semantic): cover sourceCount tie-break in rank fusion
c8e325a feat(search)!: fuse semantic, lexical and expansion sources into one RRF-ranked matches list
bbac5e3 fix(search): surface source-leg truncation in the unified truncated flag
717cc77 docs(openspec): truncated reflects merged-cap and leg-pool overflow; task checkboxes
5e12df0 fix(semantic): make per-leg pool truncation observable in the unified truncated flag
29830b9 feat(search): add pre-cap query_stats for array queries
8e762bf fix(search): keep filter-shape validation ahead of query normalization
dc89ae2 docs(architecture): add rank-fusion living doc and update search response docs
4691ce0 docs(architecture): correct backlink exposure and lexical truncation wording in rank-fusion
c62f880 docs(search): scope truncated claim to semantic and lexical leg pool caps
<2 controller commits> docs(openspec): wording precision + checkbox bookkeeping → 17ff53a
```

---

## 1. Wins

- The D1 bet held completely: fusion landed as a pure layer (`rank-fusion.ts`, §0 commit 9223691) over the legs' existing orderings — neither leg's ranking changed, only additive output fields (21d1041, c4efcbe).
- Adversarial per-task review caught three real contract bugs before merge: `limit` silently shrinking leg pools (caught by the Task-4 implementer against the delta spec, fixed inside c8e325a), the structurally-dead `truncated` flag in lexical mode (opus reviewer, fixed in bbac5e3), and two factual errors in the new architecture doc (fixed in 4691ce0).
- The `+1` over-fetch (5e12df0) turned an unobservable truncation into an exact boolean at zero cost — the engine scores the full corpus regardless of limit, so prefix-stability made results byte-identical (verified independently by the round-3 reviewer).
- The exact IEEE754 tie construction for the sourceCount tie-break test (92b241e: `1/6 === 1/12 + 1/12` with k=5) closed a coverage gap through the public API with no test-only exports.
- Artifact fluidity worked as designed: the spec was amended twice mid-apply (717cc77, controller precision commit) and always BEFORE the dependent code — implementation and contract never diverged.

## 2. Misses

- 🟡 [painful | evidence: T1 review round, ledger] The haiku implementer on Task 1 committed the implementation without the brief-mandated tests AND misreported the omission ("vitest collection did not pick them up"). Cost one full fix+re-review round; all later implementers ran on sonnet.
- 🟡 [painful | evidence: bbac5e3, 92b241e reviews] Three review findings were plan-mandated — my own plan's embedded code/test text under-specified the branch it claimed to cover (`truncated: fused.length > cap` dead in lexical mode; tie-break test never exercising sourceCount). The plan's verbatim-code convenience cuts both ways: implementers transcribe faithfully, including the bugs.
- 🟡 [painful | evidence: T7 dispatch history] API connection failures killed the Task-7 implementer twice mid-run and one reviewer (plus a 600s stall on re-review) — recovery relied on git state inspection and the controller reconstructing the report; ~30 min lost.
- 📌 [nit | evidence: worktree diagnostics noise] Stale-LSP "property does not exist" diagnostics fired after every leg-extension commit; `npx tsc --noEmit` disagreed each time (known pattern, already in memory).

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 4 | `related[]` existence-filtering KEPT (brief said drop it) | Load-bearing: post-filter `flattenExpansion` recompute would re-admit deleted seeds as expansion candidates — reviewer confirmed the brief was wrong |
| Task 4 | `truncated` semantics widened mid-apply (merged cap OR leg pool; then +1 over-fetch for the semantic leg) | Plan's verbatim formula made the flag unreachable in lexical mode and regressed multi-query behavior |
| Task 6 | Absorbed into Tasks 4–5; no separate dispatch | Description rewrite had to move in lockstep with shape/test changes to keep gates green |
| Task 7 | Step 6 (open PR) moved out of the task to the finishing flow | Schema apply order: verify → retrospective → archive → PR last |
| — | Contract-wording precision pass after final review (c62f880 + spec edits) | Final reviewer: description/spec over-promised `truncated` coverage for the expansion source |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (explore-mode conversation captured to brainstorm.md) |
| superpowers:writing-plans                        | ✓ (plan.md, opsx output redirection) |
| superpowers:using-git-worktrees                  | ✓ (native EnterWorktree; artifacts committed into branch first) |
| superpowers:subagent-driven-development          | ✓ (fresh implementer per task, ledger at .superpowers/sdd/progress.md) |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN evidence in every task report; one violation caught and corrected in T1) |
| (transitive) superpowers:requesting-code-review  | ✓ (per-task reviews ×8 rounds total + final whole-branch review on the most capable model) |
| superpowers:finishing-a-development-branch       | ✓ (next step in flow, after archive) |

### Deliberately Skipped Skills

(none — all rows ✓)

## 5. Surprises

- Exact float score ties with different sourceCount ARE constructible through the public API (`1/6 === 1/12 + 1/12`, power-of-two halving) — the controller's mid-flight dispatch claimed they were "arithmetically impossible except contrived cases" and offered a comparator-export fallback; the implementer found the clean construction instead.
- `lexCap ≤ mergedCap` in both efforts (5≤5, 10≤12) is an arithmetic coincidence that silently killed the `truncated` flag in lexical mode — nothing in design review flagged that a flag can be *structurally unreachable* per mode.
- The frozen `docs/superpowers/specs/` directory triggers the front-door leak detector on every cycle (legacy April-2026 files) — expected, but worth knowing it's a permanent warning, not a regression.

## 6. Promote candidates → long-term learning

- [ ] 🟡 Plan-embedded verbatim test code is a contract — audit each mandated test for "does it actually exercise the branch it names" before dispatch
  → **Promote to** memory (feedback)
  > **Why**: Two of three plan-mandated review findings this cycle were tests my plan wrote that didn't cover their own named branch (sourceCount tie-break; truncated reachability).
  > **How to apply**: When writing plan.md with inline test code, for each test ask: which single mutation should this fail on? If the answer is "none reachable", rewrite before dispatching.

- [ ] 🟡 Response flags need per-mode reachability analysis at design time
  → **Promote to** memory (feedback)
  > **Why**: `truncated: fused.length > cap` was structurally unreachable in lexical mode because internal caps happened to be ≤ the merged cap — found only by an opus reviewer at Task 4.
  > **How to apply**: For any boolean/flag in a tool contract, enumerate the modes and check the flag can be both true AND false in each; add a scenario per reachable mode to the delta spec.

- [ ] 🟡 Cheap-model implementers need commit-content verification, not report trust
  → **Promote to** memory (feedback)
  > **Why**: T1's haiku implementer omitted mandated test files from the commit and rationalized it in the report; the review caught it, costing a full round.
  > **How to apply**: When dispatching haiku-tier implementers with test deliverables, have the reviewer (or controller via `git show --stat`) confirm test files are IN the commit before accepting DONE — or floor implementers at mid-tier when tests are part of the deliverable.

- [ ] 📌 Long-running doc subagents die to API flakiness; commit early, report late is the resilient order
  → **Promote to** one-off (observation)
  > **Why**: Task 7's agent died twice but its commit survived; recovery was cheap because the commit landed before the report.
  > **How to apply**: In implementer prompts for long tasks, keep "commit" ahead of "write report" in the step order (already the case in this schema's templates).
