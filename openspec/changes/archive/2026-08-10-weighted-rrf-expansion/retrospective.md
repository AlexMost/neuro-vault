# Retrospective: weighted-rrf-expansion

> Written: 2026-08-10 (after verify passed)
> Commit range: `cab907d..6e15438`
> Worktree: `.claude/worktrees/weighted-rrf-expansion`

---

## 0. Evidence

- **Commit range**: `cab907d..6e15438` (7 commits; archive commit lands after this file)
- **Diff size**: +654 / −32 lines across 12 files
- **Tasks done**: 10/11 (`grep -cE '^\s*- \[x\]' tasks.md` → 10; 3.4 PR deliberately sequenced after archive per schema)
- **Active hours**: ~1 (single session: propose ≈0.5h earlier, apply ≈1h)
- **Subagent dispatches**: 10 (4 implementers, 4 task reviewers, 1 final whole-branch reviewer, 1 final-review fixer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass (9/9 items valid, see verify.md §1)
- **Test coverage signal**: vitest 872/872 passing (baseline 870; rank-fusion unit tests 6 → 9)

Commit chain (時序):

```
a012390 docs(openspec): add weighted-rrf-expansion change artifacts
23086aa feat(semantic): down-weight expansion leg in RRF fusion (w=0.85)
fe893bc feat(semantic): drop backlink_count from RRF tie-break
fa26be6 test(semantic): pin 2026-08-10 report cases as fusion regressions
785314c docs(architecture): reflect weighted RRF fusion and new tie-break
c6fc605 docs(openspec): tick completed weighted-rrf-expansion tasks
6e15438 docs: fix stale backlink tie-break references after RRF rework
```

---

## 1. Wins

- [evidence: §0 commit chain, 4 task reviews all "Approved" first pass] Plan-as-transcription worked: every implementer task carried complete code in the brief, all four shipped verbatim-correct on the first dispatch — zero fix loops at the task level, cheapest-tier models sufficed for 3 of 4 implementers.
- [evidence: plan.md Task 1 Step 3; test `breaks an exact score tie by sourceCount`] The plan pre-identified that weighting expansion would break the exact-tie fixture's `1/12 + 1/12 = 1/6` arithmetic and prescribed rebuilding the tie from the two weight-1 legs — the trap was defused at planning time instead of debugging time.
- [evidence: fe893bc; `fuseRanks` signature] Removing `getBacklinkCount` from the signature (not just the comparator) made the spec clause "`backlink_count` SHALL NOT participate in fusion ordering" unrepresentable in code — typecheck enforces the contract, not just tests.
- [evidence: verify.md §4 scenario→test table] All four delta-spec scenarios map 1:1 to named unit tests, including both live-report failure geometries (retention, Moby) as deterministic fixtures that survive vault drift.
- [evidence: final review dispatch on most-capable model] The whole-branch review earned its cost: it hand-verified fixture arithmetic, confirmed the `??`-vs-`||` zero-weight semantics, and caught the one real gap (docs/guide) that four task-scoped reviews structurally could not see.

## 2. Misses

- 🟡 [painful | evidence: final review Important #1; fixed in 6e15438] Plan Task 4's doc sweep was scoped `rg … docs/architecture/` only, so `docs/guide/finding-notes.md:119` kept asserting the exact behavior the spec now forbids ("it's the fusion tie-break used after RRF score and source count"). The guide layer restates ranking mechanics for the model audience and was invisible to the sweep. Same family as the archived audit-underused-mcp-tools candidate ("scrub framing/intros, not just token references") — the pattern is now two-for-two.
- 📌 [nit | evidence: Task 2 review Minor; fixed in 6e15438] Stale test title ("…by sourceCount before backlinks") survived Task 2 because the brief said "keep the assertion" and the implementer read that as "don't touch the title". Cost one line in the final-review fix wave.
- 📌 [nit | evidence: apply session, cp step before a012390] `EnterWorktree` branches from `origin/main`, so the propose-phase artifacts (untracked in the main checkout) did not carry into the worktree — they were copied and committed manually as the first commit. Worked, but it is an undocumented seam between `/opsx:propose` (writes to main checkout) and `/opsx:apply` (works in a fresh worktree).

## 3. Plan deviations

| Plan task     | What changed                                                                 | Why                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Task 4 Step 4 | "Open the PR" not executed inside Task 4; deferred to finishing-a-development-branch after retrospective + archive | Schema's apply instruction sequences PR last so the PR diff contains the complete archived cycle; the plan was written before that sequencing was loaded |
| (added)       | Post-final-review fix commit 6e15438 (guide doc, test title, doc clause)      | Final whole-branch review returned "With fixes"; one batched fix dispatch per SDD protocol                                                |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓ (propose phase; note-seeded, forks resolved via AskUserQuestion) |
| superpowers:writing-plans                        | ✓ (propose phase, output redirected to plan.md) |
| superpowers:using-git-worktrees                  | ✓ (native EnterWorktree, `.claude/worktrees/weighted-rrf-expansion`) |
| superpowers:subagent-driven-development          | ✓ (10 dispatches, ledger at `.superpowers/sdd/progress.md`) |
| (transitive) superpowers:test-driven-development | ✓ (Tasks 1–2 RED→GREEN with evidence in reports; Task 3 was a declared regression-pin, no RED owed) |
| (transitive) superpowers:requesting-code-review  | ✓ (4 task reviews + 1 final whole-branch review) |
| superpowers:finishing-a-development-branch       | ✓ (in flight — runs immediately after archive, next step of this session) |

### Deliberately Skipped Skills

（無 — 全部 skill 依 schema 流程執行。）

## 5. Surprises

- The lexical leg keeps its own internal backlink tie-break (`src/lib/obsidian/lexical/rank.ts:114`) by design — the final reviewer had to distinguish it from the removed fusion-level step. Expected once seen, but "backlinks removed from ranking" is only true at the fusion layer, and two docs correctly retain lexical-leg backlink language.
- `expansionWeight: 0` is already meaningful ("expansion off" for future harness sweeps) purely because Task 1's code used `??` instead of `||` — a semantics win nobody planned explicitly; the final review verified it rather than any test.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Doc sweeps after behavior changes must cover `docs/guide/` (model-facing layer), not only `docs/architecture/`** → **Promote to** memory (type: feedback)

  > **Why**: This cycle's plan-scoped `rg docs/architecture/` missed `docs/guide/finding-notes.md:119` stating the removed backlink tie-break as current behavior; the archived audit-underused-mcp-tools retro hit the same family (prose describing gone capability survives token greps). Two cycles, same shape.
  > **How to apply**: When a change alters ranking/tool behavior described in docs, sweep `docs/` wholesale (`rg -i <mechanism terms> docs/`) and re-read the guide sections that explain the changed mechanism — architecture-scoped greps are not a completed sweep.

- [ ] 📌 **`/opsx:propose` artifacts are untracked in the main checkout; `EnterWorktree` (fresh from origin/main) won't contain them — copy + commit them as the worktree's first commit** → **One-off** (schema/tooling seam; revisit only if it recurs painfully)

  > **Why**: This cycle needed a manual `cp -R` before apply could commit artifacts into the PR branch; silent omission would have produced a PR without the planning record the schema requires.
  > **How to apply**: First action after EnterWorktree in an opsx apply: copy `openspec/changes/<name>/` from the main checkout and commit (`docs(openspec): add <name> change artifacts`).

- [ ] 📌 **In fix briefs, "keep the assertion" needs a companion "and update names/titles that describe removed mechanisms"** → **One-off** (covered case-by-case by reviewer rubric; not worth a standing rule yet)

  > **Why**: Task 2's brief preserved a test's assertions but its title still named the deleted backlink step; the Minor survived one review cycle before the final review forced the rename.
  > **How to apply**: When a brief instructs preserving a test's intent through a mechanism removal, include renaming its title/comments in the same instruction.
