# Retrospective: semantic-floor-recalibration

> Written: 2026-10-29 (after verify passed with warnings)
> Commit range: `ea81059..1872712` (archive commit follows)
> Worktree: `/Users/amostovenko/worktree/neuro-vault/lucid-mayer-5135e1`

---

## 0. Evidence

- **Commit range**: `ea81059..1872712` (4 commits before the archive commit)
- **Diff size**: +1125 / −111 lines across 33 files (most of it the change's own artifacts and docs)
- **Tasks done**: 10/11 at verify; 6.3 is this close-out
- **Active hours**: about 1.5
- **Subagent dispatches**: 1 (whole-branch reviewer)
- **New external dependencies**: none
- **Bugs encountered post-merge**: none yet
- **OpenSpec validate state at archive**: pass (27/27)
- **Test coverage signal**: vitest 2921 passed (+9)

Commit chain:

```
e52ce0f docs(openspec): propose semantic-floor-recalibration
5b256ba feat(semantic): recalibrate harrier-270m floors, optional fallback, own block floor
2d783d4 docs(semantic): document the recalibrated harrier-270m floors
1872712 test(semantic): pin harrier-270m's no-retry description; fix a stale doc line
```

---

## 1. Wins

- [evidence: verify.md §Eval] The noise metric landed exactly on the #222 simulation at both
  efforts: controls returning anything went from 17 to 6, with means of 1.29 and 2.29. The
  map's simulation through the real pipeline was trustworthy for the metric it targeted.
- [evidence: 5b256ba] Splitting `blockFloor` out of `deep` kept the change behaviour-neutral for the
  two other profiles. The parity oracle (`test/semantic/_legacy-retrieval.ts`) needed only a
  narrower input type, `Required<SimilarityDefaults>`, not a behaviour edit.
- [evidence: verify.md §Eval] Re-running the "before" on `main`'s code at the same vault commit
  (a temporary detached worktree) made the comparison clean, although the vault auto-commits
  every few minutes.

## 2. Misses

- 🟡 [painful | evidence: verify.md §Eval] The deep R@10 guard is not met (0.824 against about
  0.843, simulated 0.841). It goes to the owner at review. The simulation ran on an earlier vault
  state with a deep hit@3 of 0.905. Its deep R@10 cost was already larger than one entry and was
  accepted in the decision table, so the guard as written in #230 was tighter than the decision
  it came from.
- 📌 [nit | evidence: 5b256ba, retrieval-policy.test.ts] The new "no retry without a fallback"
  test passed before the implementation: `threshold > undefined` is false, so the old code
  already skipped the retry by accident. The test still pins the behaviour, but the RED step
  showed nothing.
- 📌 [nit | evidence: 1872712] The doc sweep missed one "`deep` default" line, in the starved-seed
  paragraph. The reviewer caught it. The grep pattern was `deep default` while that line said
  "internal `deep` default", with backticks in between.

## 3. Plan deviations

| Plan task | What changed | Why |
| --- | --- | --- |
| 1 | `TEST_SIMILARITY` is typed `Required<SimilarityDefaults>`, and so is the legacy oracle's input | The frozen oracle reads `similarity.fallback` as a number; it must not be edited to follow production |
| 3 | The source-grep pin asserts `${retryClause(similarity.fallback)}` | Review: a bare `${fallback}` no longer tied the description to the profile |
| 6.2 | Added a local deep-floor sweep (0.40–0.44) | The guard failed. The owner needs the trade-off curve to rule, not just the breach |
| 6.3 | Native execution and one whole-branch reviewer, not per-task subagents | Stated in plan.md: one type change every task compiles against, and small tasks |

## 4. Skill / workflow compliance

| Skill | Used |
| --- | --- |
| superpowers:brainstorming | ✓ (in the wayfinder map; brainstorm.md carried in) |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ (the session's own app worktree) |
| superpowers:subagent-driven-development | ✗ |
| (transitive) superpowers:test-driven-development | ✓ (tests first per task) |
| (transitive) superpowers:requesting-code-review | ✓ (one whole-branch reviewer) |
| superpowers:finishing-a-development-branch | ✓ (PR, no local merge) |

### Deliberately Skipped Skills

- **`superpowers:subagent-driven-development`**
  - **What was skipped**: per-task implementer and reviewer subagents. The final whole-branch
    review ran.
  - **Why this cycle**: Task 1 changes `SimilarityDefaults` (5b256ba), and every later task
    compiles against it. Typecheck cannot pass between tasks 1 and 2–4, so per-task subagents
    would each have inherited a red tree. The change is also four small edits.
  - **How to prevent recurrence**: `scope-judgment rule`. The precedent run (graph-read-errors)
    made the same call from a side session. A change whose first task is a type change
    consumed by every other task, under about 300 lines of code, runs natively with one
    whole-branch reviewer. plan.md states this under "Execution".

## 5. Surprises

- The vault behind the eval auto-commits ("vault backup") several times an hour, so `vault_sha`
  differs between back-to-back runs. Comparable reports need the before and after on the same
  commit, which means re-running `main`'s code rather than reusing an earlier report.
- Below 0.45, deep recall gets *worse* before it gets better (0.819 at 0.42–0.44 against 0.824 at
  0.45). Weak seeds cost twice: their own slot, and the expansion neighbours they recruit.
- A post-checkout lefthook hook in a scratch worktree ran `npm ci` through a symlinked
  `node_modules` and replaced the symlink with its own install. The lockfile was identical,
  so no harm was done.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **An eval before/after must share a vault commit; re-run `main`'s code at the after-run's
      commit** → **Promote to memory** (type: feedback)
  > **Why**: the owner's vault auto-commits every few minutes, and reports are comparable only on
  > an equal, clean `vault_sha`.
  > **How to apply**: any change measured with `npm run eval` on the owner's vault. Run the
  > before from a detached worktree of `main` right after the after-run.
- [ ] 🟡 **A guard copied into an issue must match the decision's own simulated numbers** →
      **One-off** (raise at review)
  > **Why**: #230's guard allowed one entry of R@10 loss, while #222's accepted table already lost
  > more at deep.
  > **How to apply**: when turning a map decision into an epic sub-issue, take the guard from the
  > chosen row of the simulation table.
- [ ] 📌 **A scratch worktree with symlinked `node_modules` triggers lefthook's `npm ci`** →
      **One-off**
  > **Why**: `scripts/sync-deps.sh` runs on post-checkout whenever the lockfile differs from the
  > previous HEAD's, and a fresh worktree's "previous HEAD" is null.
  > **How to apply**: create scratch worktrees with `-c core.hooksPath=/dev/null`, or accept the
  > install.
