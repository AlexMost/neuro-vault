# Retrospective: sync-docs-fused-contract

> Written: 2026-08-10 (after verify passed)
> Commit range: `b27802b..e11d238`
> Worktree: `.claude/worktrees/sync-docs-fused-contract`

---

## 0. Evidence

- **Commit range**: `b27802b..e11d238` (5 commits vs `origin/main`)
- **Diff size**: +537 / -3 lines across 10 files (527 of the + lines are the change artifacts themselves; the living-docs payload is 3 files, ±10 lines)
- **Tasks done**: 8/8 (`grep -cE '^\s*- \[x\]' tasks.md` → 8)
- **Active hours**: ~0.5 (single session, propose → apply → verify)
- **Subagent dispatches**: 7 (2 implementers, 2 task reviewers, 1 final whole-branch reviewer, 1 fixer, 1 re-reviewer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (pre-merge)
- **OpenSpec validate state at archive**: pass (9/9 items)
- **Test coverage signal**: vitest 885 passed (74 files) — unchanged by design; docs-only
- **Out-of-branch work**: vault `AGENTS.md` (5 sentence-level fixes via MCP, read-back verified) + deletion of untracked `openspec/changes/polish-fused-response-contract/` in the main checkout (superset diff check first)

Commit chain (時序):

```
b27802b docs(openspec): add sync-docs-fused-contract change artifacts
9499748 docs(spec): restate lexical-only search_notes scenario against fused matches[] contract
1e8a7bc docs(architecture): point rank-fusion D3 link at committed archive path
3af3951 docs(openspec): tick sync-docs-fused-contract tasks after apply
e11d238 docs: fix stale pre-archive link in lexical-search.md; align change-artifact wording with sweep reality
```

---

## 1. Wins

- [evidence: §0 diff size] Payload stayed surgical — 3 living-docs files, ±10 lines, byte-identical to the delta spec where it mattered (9499748 vs delta THEN-clause, confirmed by two independent reviewers).
- [evidence: brainstorm.md §Verification] Re-verifying all four vault-note items against current state *before* writing artifacts caught that item 3 had drifted (the four named dirs were already gone; the same failure mode had recurred as `polish-fused-response-contract/`) — the plan encoded the failure mode, not a stale literal list.
- [evidence: e11d238] The final whole-branch review earned its cost on a tiny branch: it found a second instance of the exact defect class being fixed (`lexical-search.md:131` pre-archive link) that the task-scoped sweeps missed because the grep targeted contract vocabulary, not link paths.
- [evidence: §0 out-of-branch] Vault-side read-back verification caught a fifth stale claim beyond the plan's four (`effort` bullet promising nested `related[]`, forbidden by hybrid-search spec:151) — fixed in the same pass instead of shipping a half-synced file.
- [evidence: task-2 dispatch + plan Task 2 Step 3] The delete-guard worked as designed: diff direction was re-confirmed (archive strictly newer/superset) immediately before `rm -rf`, from live output rather than memory.

## 2. Misses

- 🟡 [painful | evidence: two refused Bash calls after Task 2] `cd /Users/amostovenko/git/neuro-vault && …` in a worktree-isolated session set the persistent shell cwd to the shared checkout, after which the harness refused every command (even ones that `cd` back) until the session re-entered the worktree via `EnterWorktree {path}`. Cost two dead round-trips.
- 🟡 [painful | evidence: plan Task 2 vs execution] The plan assigned the untracked-dir deletion to the worktree task, but untracked files don't exist in a fresh worktree — the step could never run where it was written. Caught at dispatch time and rerouted to the controller, but the plan should have carried the placement.
- 📌 [nit | evidence: filter-branch in ledger] Commit trailers diverged mid-branch (session default `Claude Fable 5` vs repo convention `Claude Opus 4.7`), needing a msg-only `filter-branch` before push. Known repo convention that wasn't applied to the controller's own commits, only to subagents'.
- 📌 [nit | evidence: final review Finding 2] Three artifacts asserted a sweep outcome ("returns nothing") that was never achievable — the branch's own edit adds the tokens inside negative assertions. Acceptance criteria should be written against the expected end state, not an idealized one.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| Task 2 Steps 3-4 | Executed by controller in main checkout, not the worktree implementer | Untracked dirs don't propagate to worktrees; the target only exists in the shared checkout |
| Task 3 | 4 planned replacements became 5 | Read-back verification surfaced a stale nested-`related[]` claim in the effort bullet — same defect class, same file, fixed under D4's intent; recorded in ledger + verify §4 |
| Task 4 Step 4 (PR) | Deferred past verify → retrospective → archive | Bridge's canonical sequence ("PR is the LAST step") overrides the plan's inline PR step |
| (added) e11d238 | Post-final-review fix commit | Final review found a second broken pre-archive link + artifact-wording drift; fixed in-branch rather than follow-up |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (pre-converged input; captured as decision log, forks Q1-Q4 resolved in-skill) |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ (native `EnterWorktree`) |
| superpowers:subagent-driven-development          | ✓ (7 dispatches, per-task + final review) |
| (transitive) superpowers:test-driven-development | ✗ |
| (transitive) superpowers:requesting-code-review  | ✓ (task reviews + final whole-branch review) |
| superpowers:finishing-a-development-branch       | ✓ (ran after archive, per bridge sequence) |

### Deliberately Skipped Skills

- **`superpowers:test-driven-development`**
  - **What was skipped**: the RED-GREEN-REFACTOR cycle per task, in full
  - **Why this cycle**: every deliverable is prose (2 markdown link/scenario edits in-branch, vault file out-of-branch) — commits 9499748/1e8a7bc/e11d238 touch zero executable code, and the contract being documented already has its behavior covered by the existing 885-test suite from the 14.0.0 cycle. There is no failing test to write for a sentence; the plan defined command evidence instead (`openspec validate --all`, grep sweeps, `ls` target checks), which each implementer ran and reported.
  - **How to prevent recurrence**: scope-judgment rule — for docs-only tasks (diff touches no `src/`/`test/` path), TDD's slot is filled by named verification commands in each plan step; reviewers check the command output is present in the report. This retro records the rule; recurrence of the same skip with the same rationale is expected and correct for this task class.

## 5. Surprises

- The stale-leftover failure mode (item 3) had *already recurred* between the vault note's writing and this cycle — a 2-day-old note was stale about the thing it reported as stale. State re-verification at propose time is not optional polish.
- A branch whose entire point was "fix stale contract references" itself contained a same-class defect the task list missed (`lexical-search.md`), found only by the whole-branch reviewer reading the design's Goals ("cross-references in living docs resolve in a fresh clone") rather than the task list.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **Archiving an opsx change must sweep living docs for `openspec/changes/<name>` links and delete the pre-archive scaffold left in the main checkout.** → **Promote to** project CLAUDE.md / opsx-routing rule (archive checklist)
  > **Why**: two cycles in a row left both artifacts behind — rank-fusion.md + lexical-search.md linked never-committed pre-archive paths, and `polish-fused-response-contract/` sat untracked diverging from its committed archive until this cycle deleted it.
  > **How to apply**: in `/opsx:archive` (or right after), run `grep -rn "openspec/changes/" docs/ README.md --exclude-dir=superpowers | grep -v archive/` and fix hits, and remove the now-archived change's untracked scaffold from the main checkout when apply ran in a worktree.

- [ ] 🟡 **In a worktree-isolated session, never `cd` the persistent shell into the shared checkout — use absolute paths for read-only peeks, and `EnterWorktree {path}` to recover if wedged.** → **Promote to** memory (type: feedback)
  > **Why**: this cycle lost two round-trips when a compound `cd <main-checkout> && diff` set the persistent cwd outside the worktree and the harness began refusing all subsequent commands pre-exec.
  > **How to apply**: during any opsx apply in a worktree, main-checkout inspection goes through absolute-path arguments (no `cd`, no `git -C`); if the guard trips, re-issue `EnterWorktree` with the worktree path instead of retrying variants.

- [ ] 📌 **Plan steps that touch untracked files must name the checkout they live in — untracked state does not propagate to worktrees.** → **One-off** (plan-authoring note)
  > **Why**: plan Task 2 placed an `rm -rf` of an untracked dir inside the worktree task where the dir cannot exist; caught at dispatch, rerouted to the controller.
  > **How to apply**: when writing plans that mix worktree implementation with shared-checkout state cleanup, mark each step's execution locus explicitly (as Task 3 already did for the vault).

Carry-forward check (`grep -A 5 '^- \[ \]' archive/*/retrospective.md`): the 2026-06-08 candidate "scrub framing/intros that imply the capability — not just direct token references" was re-validated this cycle (the vault `related[]` claim survived a token grep and fell to a read-back); it remains unchecked and is reinforced, not stale.
