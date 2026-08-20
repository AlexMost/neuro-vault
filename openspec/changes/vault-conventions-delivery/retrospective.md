# Retrospective: vault-conventions-delivery

> Written: 2026-08-20 (after verify passed)
> Commit range: `d6b1333..4e40ae4`
> Worktree: `.claude/worktrees/vault-conventions-delivery`

---

## 0. Evidence

- **Commit range**: `d6b1333..4e40ae4` (10 commits)
- **Diff size**: +2624 / -276 lines across 55 files
- **Tasks done**: 29/29
- **Active hours**: ~2.5h wall-clock, one controller session
- **Subagent dispatches**: 11 (4 implementers incl. 2 resumes, 5 task/re-reviews, 2 whole-branch reviews)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass — 9 passed, 0 failed
- **Test coverage signal**: vitest 915 → **945** (+30), 76 → 78 files. No test deleted without a justified replacement.

Commit chain:

```
868cbfe refactor(conventions): extract shared vault-conventions reader
5440bf1 feat(conventions): expose readConventions per vault entry
ac9b81d feat(overview): deliver vault conventions through get_vault_overview
8afe489 docs(openspec): add vault-conventions-delivery change artifacts
16921cf fix(overview): scope the conventions directive to vault organisation
f0e25dc fix(instructions): deliver vault conventions within the client truncation budget
699f86e fix(tools): rehome in-vault scan guidance and enumerate registered vaults
98e9dce docs: record vault-conventions delivery and ADR-0010
2aa6bb3 docs: state the conventions delivery promise across guide and README
4e40ae4 docs: correct the multi-vault contract claim in ADR-0010
```

---

## 1. Wins

- [evidence: `f0e25dc`, task-6-7 audit table] **The pre-delete audit was the highest-value step in the cycle.** The plan predicted one orphan; the audit found **five**, plus two multi-vault contract gaps (`VAULT_REQUIRED`, `failed_vaults`) that the brief had *asserted* were already covered by tool descriptions and were not. Without the audit those contracts would have been deleted outright — they lived only in the `instructions` string that never arrives.
- [evidence: `f0e25dc`, `src/modules/semantic/tools/search-notes.ts:523-539`] **Three deleted `search_notes` sections turned out to be factually stale**, documenting a `mode: quick|deep` parameter and a `results`/`related` response shape that no longer exist — left behind by the hybrid-search rework. Deleting them is a correctness win independent of this change; the server had been mis-instructing models.
- [evidence: `ac9b81d`, `test/lib/obsidian/vault-conventions.test.ts:47-56`] **A latent collapse in `capConventions` was caught before it went live.** Inherited verbatim from `previewBody`, the word-boundary cut reduced an 8,000-character budget to one character when the only whitespace sat near the start (`' ' + 'y'.repeat(9000)` → a single ellipsis). Reachable via fenced code blocks, long URLs, or wide tables. Inert until this change gave it its first caller; fixed with a bounded 200-char look-back and a regression test on that exact input.
- [evidence: Task 5 dogfood, verify.md §7] **The freshness guarantee was proven against the real vault**, not just stubs: an edit made between two handler calls was visible with no restart (6,755 → 6,818 chars), and the file was restored byte-identically (sha256 verified). No stub could have established this.
- [evidence: `test/server-instructions.test.ts:66-105`] **The load-bearing test asserts the real contract**, not a proxy: it slices to 2048 and asserts the conventions block *and* the whole preamble are intact inside the slice. Asserting total length instead would have passed on a shorter file and broken the moment a real one grew.
- [evidence: verify.md §5, final review] **Net token cost is negative.** ~1.7k characters added to tool descriptions against ~10.6k removed from `instructions` — and for Claude Code, `instructions` was capped at 2048 anyway, so the trade is ~400 tokens of descriptions for content that now actually arrives, sub-agents included.

## 2. Misses

- 🔴 [blocking | evidence: `98e9dce` → `4e40ae4`, ADR-0010:27] **ADR-0010's central mechanism claim was wrong twice.** The first version said `describeMultiVault` "appends the fan-out contract" to every multi-vault-aware description. The implementer's own self-review flagged it, "corrected" it — and the correction was still false: `search_notes` never calls `describeMultiVault`, and 9 of 14 tools carry `EXPLICIT_VAULT_SUFFIX`, the *opposite* contract. Only the docs-accuracy review caught it. For an ADR whose whole purpose is telling future work which channel carries which contract, this is the defect class that matters most. Root cause: the claim was **inherited from design.md D3**, which had the same over-generalisation — nobody verified D3 against source when it was written.
- 🟡 [painful | evidence: design.md D8 vs measurement] **The design's cap rationale was invented, not measured.** D8 justified 8,000 as "roughly 6× a typical ~1,200-character conventions file, so trimming should be rare". The real file in use is **6,755 characters — 84% of the cap**. The number "1,200" had no source; it then propagated into the plan's test fixture and the acceptance criteria.
- 🟡 [painful | evidence: task-8-9 agent BLOCKED report] **The controller wedged a running subagent** by switching worktrees to service an unrelated task mid-round. The agent's isolation binding followed the session, leaving it unable to touch its own branch. It recovered gracefully — writing exact replacement text to a scratchpad — but the round was lost and the controller finished the fixes by hand.
- 🟡 [painful | evidence: plan.md Task 3 step 5, Task 6 step 5] **The plan mandated committing with `tsc --noEmit` red, twice**, contradicting its own Global Constraints. Both pairs (3+4, 6+7) had to be merged into single commits at dispatch time. The plan's self-review *noticed* this for 3+4 and wrote an escape hatch into the prose rather than fixing the task boundary — then repeated the identical mistake at 6+7.
- 📌 [nit | evidence: final review Minor 1, `src/server.ts:57`] `buildServerInstructions` calls `readConventions()` bare while the overview path wraps the same call in try/catch. Behaviourally safe only because the production reader swallows everything; the two channels are asymmetrically defended for one contract.
- 📌 [nit | evidence: final review Minor 4] The `vault://overview` resource description doesn't carry the authority sentence its sibling tool has, even though D9's own argument ("without that sentence the field is inert") applies to both surfaces.
- 📌 [nit | evidence: `.superpowers/` lint failure] SDD scratch tripped `eslint` and `prettier --check`, blocking two commits mid-run. Fixed in a separate PR (#70) rather than here.

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 3 + 4 | Merged into one commit (`ac9b81d`) | Task 3 step 5 instructed committing while `tsc` was red, contradicting the Global Constraint that all gates pass before any commit. The constraint governs; the plan's own self-review offered this resolution. |
| 4 | Added an unplanned requirement: fix `capConventions`' collapse | Task 1's review surfaced it; this task gave the function its first caller, so it was the moment it went live. |
| 5 | Run by the controller, no subagent, no commit | Manual dogfood against the real vault needs the live environment; it is a verification step, not a code change. |
| 6 + 7 | Merged into one commit (`f0e25dc`) | Identical reason to 3+4 — Task 6's cap test was designed to stay red until Task 7. |
| 7 | Blast radius grew from ~1 file to 16 | The audit found 5 orphans and 2 multi-vault contract gaps, all requiring rehoming into tool descriptions via a new shared `EXPLICIT_VAULT_SUFFIX`. |
| 8 | Step 3 (`mcp-server-shape.md`) was largely already done by `f0e25dc` | The instructions commit correctly updated the doc describing the layering it changed. Task 8 reduced it to a pointer instead of rewriting. |
| 9 | Sweep widened beyond the brief's grep | The brief's grep was narrower than the behaviour that changed; three extra probes found 14 hits / 9 stale vs the brief's 9 / 4. |
| — | PR structure: 3 PRs → 1 | The plan's PR boundaries were overridden by the user mid-cycle. PR #69 now carries the complete archived cycle. |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (verbal, captured raw in `brainstorm.md`) |
| superpowers:writing-plans                        | ✓ |
| superpowers:using-git-worktrees                  | ✓ |
| superpowers:subagent-driven-development          | ✓ |
| (transitive) superpowers:test-driven-development | ✓ (RED→GREEN evidence in every implementer report) |
| (transitive) superpowers:requesting-code-review  | ✓ (5 task reviews + 2 whole-branch reviews) |
| superpowers:finishing-a-development-branch       | ✓ |

### Deliberately Skipped Skills

None — all green.

## 5. Surprises

- **The bug was worse than "the file is too big".** The original diagnosis framed it as a size problem. Measurement showed the conventions block begins past character ~11,000 behind a 10,803-character preamble, so it is dead at *any* file size, including empty. Ordering was the defect; size was a symptom.
- **Sub-agents receive no `instructions` at all** — not a truncated slice, nothing. This inverted the design: it is why tool *descriptions* became the rehoming target rather than a shorter `instructions` string.
- **The `instructions` preamble was actively mis-instructing models.** Three of its `search_notes` sections documented a parameter enum and a response shape that no longer existed. The channel nobody could read was also the channel nobody had maintained.
- **The measured file was at 84% of a cap the design called "6× headroom".** The one number in the design that could have been measured up front was the one that was guessed.
- **`git check-ignore -q <dir>` is not a reliable "is this ignored" test.** It returned non-zero for `.superpowers/` while `git status --ignored` showed it as ignored — the skill self-ignores via a nested `.gitignore` containing `*`. This produced a false claim in a filed task that had to be retracted.

## 6. Promote candidates → long-term learning

- [ ] 🔴 **Verify a factual claim about code against the code, before writing it into a durable artifact — and again after "correcting" it.** → **Promote to memory** (type: feedback)
  > **Why**: ADR-0010's mechanism claim was false, self-reviewed, "corrected", and still false; it was inherited unverified from design.md D3. Two agents asserted it confidently. Only a review that read `vault-param.ts` and `search-notes.ts` caught it.
  > **How to apply**: When writing an ADR, architecture doc, or design rationale that names a function, module, or an "every X does Y" mechanism, grep for the symbol and count the call sites before committing the sentence. A self-correction is not evidence — re-verify it the same way.

- [ ] 🔴 **Never switch worktrees while a subagent is running in one.** → **Promote to memory** (type: feedback)
  > **Why**: Servicing an unrelated task mid-round rebound the running agent's isolation to the new worktree; it could no longer touch its own branch and lost the round. Cost a full fix cycle plus manual recovery.
  > **How to apply**: Before `ExitWorktree` / `EnterWorktree`, check `ListAgents` for running subagents. If any are live, finish or stop them first — queue the unrelated task instead of interleaving it.

- [ ] 🟡 **A plan must not instruct committing with a gate red.** → **Promote to schema** (superpowers-bridge `plan` artifact instruction)
  > **Why**: This plan did it twice (Tasks 3 and 6), each time because a type change and its callers were split across task boundaries. The self-review spotted it once and wrote an escape hatch into the prose instead of redrawing the boundary — then repeated it.
  > **How to apply**: In `writing-plans`, when a task's deliverable leaves a repo-wide gate failing, that is a signal the task boundary is wrong. Merge it with the task that repairs the gate rather than documenting the red state.

- [ ] 🟡 **Measure the number before writing the rationale that depends on it.** → **Promote to memory** (type: feedback)
  > **Why**: design.md D8 justified an 8,000-character cap as "~6× a typical ~1,200-character file". The real file was 6,755 — 84% of the cap. The invented "1,200" then propagated into the plan's test fixture and the acceptance criteria.
  > **How to apply**: When a design decision turns on a size, count, or threshold about real user data, measure the actual artifact during the design phase and cite it. If it cannot be measured yet, mark the number explicitly as unmeasured in Open Questions.

- [ ] 🟡 **Audit before deleting: prove the content has another home, per section, in writing.** → **Promote to project CLAUDE.md** (`AGENTS.md` workflow section)
  > **Why**: The audit found 5 orphans where the plan predicted 1, and 2 multi-vault contracts that existed *only* in the deleted text. It also found 3 stale sections. A confident deletion would have silently dropped live contracts.
  > **How to apply**: Any change that deletes prose from a delivery channel (MCP `instructions`, tool descriptions, README) must produce a per-section table — section → covering destination → file:line evidence — in the PR body before the deletion lands.

- [ ] 📌 **`git check-ignore -q <dir>` does not answer "is this ignored".** → **One-off**
  > **Why**: It returned non-zero for a directory whose contents `git status --ignored` reported as ignored, because the rule lived in a nested `.gitignore`. Led to a false claim in a filed task. Doesn't generalise beyond "test a concrete file path, or use `git status --ignored`".
