# Retrospective: per-model-corpus

> Written: 2026-10-14 (after verify passed with warnings)
> Commit range: `0b28012..bf92d7a` (plus the verify/retro commit and the archive commit)
> Worktree: `.claude/worktrees/per-model-corpus-apply-720f9d` (branch `claude/per-model-corpus-apply-720f9d`)

---

## 0. Evidence

- **Commit range**: `0b28012..bf92d7a` (18 commits before verify/archive)
- **Diff size**: +2583 / −176 lines across 39 files; `src/` + `eval/`: +835 / −66 across 14 files
- **Tasks done**: 14/14 (`tasks.md`)
- **Active hours**: ~0.8 h wall-clock (22:10 → 23:00, one session)
- **Subagent dispatches**: 21 — 8 implementer dispatches + 1 resumed fix round, 9 task / re-reviews, 1 final whole-branch review, 1 final re-review, 1 scenario-coverage mapper
- **New external dependencies**: none
- **Bugs encountered post-merge**: n/a (not merged yet)
- **OpenSpec validate state at archive**: pass (`validate --all`: 20/20)
- **Test coverage signal**: vitest 1560 → 1666 passed (+106), 4 skipped; 50 of 58 delta-spec scenarios have a direct test, 8 rely on lower-level tests plus the manual check (verify.md §4)

Commit chain:

```
3fdadc2 refactor(corpus): name the per-model corpus layout and share the manifest validator
5ba436c feat(corpus): keep one corpus directory per model
f2fafb3 feat(corpus): migrate a single-corpus layout into its model directory
43acb61 feat(corpus): add a cross-process reconcile lock
2ccb990 feat(corpus): list and prune other models' corpora
b8b3e5e feat(corpus): reconcile under the vault lock, migrating the old layout first
3364c28 feat(semantic): keep serving while another process holds the corpus lock
b3e4ced feat(cli): add index --prune and report waits for another process
35c3d72 feat(eval): read the selected model's corpus and name the others present
1fc493c docs(adr): revisit ADR-0017 — per-profile corpus directories adopted
4a10fe7 docs(architecture): per-model corpus directories, migration and the reconcile lock
7166686 docs: switching models no longer rebuilds the corpus; document index --prune
77b852d docs: correct the disk figure and prune-skip wording
db923b4 fix(corpus): time the lock grace per file and bound a lock path that reads as absent
ce8b30b fix(corpus): refuse to prune when the kept model's corpus has no manifest
8602023 fix(index): announce a prune's lock wait and drop the unknown-holder parenthesis
bc24cfd docs: describe the prune's refusal, its lock wait line and who announces a wait
bf92d7a docs(openspec): record the final-review lock and prune refinements in the design
```

---

## 1. Wins

- A plan with complete code and tests per task made implementation near-transcription: every code task landed in one implementer dispatch with no fix round (`3fdadc2`…`35c3d72`); only the docs task needed one round.
- Injected `pid` / `isAlive` / `sleep` / `now` made the lock testable with exact sleep sequences, and the two-pass reconcile test gates the holder's embed on the waiter's `onLockWait`, so serialisation is observable rather than timing-dependent (`reconcile.test.ts` "serialises two passes over one vault…").
- The real two-process manual check matched the design on the first run: one process embedded 40, the other waited once then reused 40; legacy layout migrated with `embedded=0` (verify.md §7).
- The final whole-branch review earned its cost: it found two real defects no task review could see — a grace-timer race that let a waiter delete a fresh lock (confirmed by simulation), and two concurrent `--prune` runs of different models deleting each other's corpus (`db923b4`, `ce8b30b`).
- The docs review checked every behavioural claim against code and caught a disk figure off by 5–10× inherited from design.md (`77b852d`).

## 2. Misses

- 🟡 [painful | evidence: `db923b4`, `ce8b30b`] The plan's lock code reset `unreadableSince` only on a parse, and `--prune` took the lock separately from the reconcile with no guard. Both were design-level gaps that survived the proposal review and the per-task reviews; only a cross-module review found them.
- 🟡 [painful | evidence: `77b852d`] design.md stated "a few MB per thousand notes" without arithmetic; the docs repeated it. Measured: ~20 MB for the default profile on a ~900-note vault.
- 🟡 [painful | evidence: `7166686` → `77b852d`] The plan's sweep grep missed `embedding-pipeline.md:106` ("a vault indexed with a different profile is rebuilt"). A phrase list cannot anticipate every wording of a falsified claim.
- 📌 [nit | evidence: verify.md §4] Eight delta-spec scenarios have no direct automated test (the CLI tests stub `reconcile`; the backend has no multi-model or dispose-during-wait test). The manual check covers them once; nothing guards them in CI.
- 📌 [nit | evidence: ledger] Deferred minors left in code: the dangling-symlink lock path announces no wait; `defaultPrune`'s `onLockWait` is not try/catch-guarded like reconcile's; the reconcile test harness store has no `warn` (pre-existing stderr noise from #97).

## 3. Plan deviations

| Plan task | What changed | Why |
|-----------|--------------|-----|
| 1.2 | Also updated `test/eval/run.test.ts`'s gate expectation to the missing-corpus message | Another profile now means another directory (D10); the old test relied on harrier reading granite's corpus |
| 2.1–2.3 | Run sequentially in one worktree, one implementer dispatch, one review | `tasks.md` allows sequential; subagent-driven-development forbids parallel implementers in one tree |
| 3.3–3.4 | One dispatch, two commits; 3.4 also updated `test/eval/run.test.ts` for the new "(this vault has corpora for: …)" suffix | Same-file follow-on of 1.2's change |
| 4.2 | Lock content documented as `{ host, pid, token, acquired }`; reserved names `notes`, `manifest.json`, `reconcile.lock` | Plan text said `{ pid, acquired }` / "never `notes`"; design D5/D2 are binding |
| 4.3 | Swept `embedding-pipeline.md`, `module-structure.md`, `configuration.md` too | Broader sweep found stale claims outside the named files |
| (new) final fix wave | Lock grace per file; bounded vanished-lock path; reworded timeout message; prune guard + spec scenario; prune wait line; no-parenthesis wait line for an unknown pid; design D5/D8/D9 updated | Final whole-branch review findings |
| 5.1 | Re-run after the fix wave, plus a new step 7 (two concurrent `--prune` of different models) | The fix wave changed lock and prune behaviour |

## 4. Skill / workflow compliance

| Skill                                            | Used |
|--------------------------------------------------|------|
| superpowers:brainstorming                        | ✓ (proposal session, `brainstorm.md`) |
| superpowers:writing-plans                        | ✓ (proposal session, `plan.md`) |
| superpowers:using-git-worktrees                  | ✓ (dedicated worktree cut from the proposal branch; `npm ci` first) |
| superpowers:subagent-driven-development          | ✓ (ledger, per-task review, final review, one fix wave) |
| (transitive) superpowers:test-driven-development | ✓ (RED/GREEN evidence in every implementer report) |
| (transitive) superpowers:requesting-code-review  | ✓ (task reviews + final whole-branch review on the most capable model) |
| superpowers:finishing-a-development-branch       | ✓ (PR via `gh pr create`) |

### Deliberately Skipped Skills

None.

## 5. Surprises

- The plan's code was correct to the letter and still had a race: "complete code in the plan" moves review of the code's design into plan review, where nobody runs a simulation. The race needed a review that held the lock, reconcile and prune in one view.
- Separate lock acquisitions for reconcile and prune looked safe per task ("prune runs under the lock") but composed into a lost-corpus scenario across two processes.
- The ADR-0017 alternative it revisits was rejected for "rare model switches"; one afternoon of seven MCP sessions made switching continuous.

## 6. Promote candidates → long-term learning

- [ ] 🟡 Two locked sections in sequence are not one locked section — check invariants that span them.
  → **Promote to** memory
  > **Why**: `index --prune` reconciled under the lock, released, then pruned under a second acquisition; two runs of different models interleaved and deleted each other's corpus (`ce8b30b`).
  > **How to apply**: when a design takes a cross-process lock more than once in one operation, list each invariant that must hold across the gap and either re-check it inside the second section or hold one lock.

- [ ] 🟡 A lock's "being written" grace must be keyed to the file instance, not to the waiter.
  → **Promote to** one-off (recorded in design D5 and `reconcile-lock.ts`)
  > **Why**: a waiter that had once seen an unparseable lock carried its timestamp into the next file and deleted a fresh lock at once (`db923b4`).
  > **How to apply**: any "stale after N ms of X" rule resets when the observed object changes (vanish, replace).

- [ ] 📌 Sweeps for a falsified claim need a behavioural grep, not a phrase list.
  → **Promote to** memory (extends "Doc sweeps must cover docs/guide too")
  > **Why**: the plan's phrase list missed "a vault indexed with a different profile is rebuilt" (`77b852d`).
  > **How to apply**: after a behaviour change, grep the verb of the old behaviour (`rebuil`, `discard`, `switch`) across docs/, README.md and eval/README.md and read every hit.

- [ ] 📌 Size claims in a design carry their arithmetic.
  → **Promote to** one-off
  > **Why**: "a few MB per thousand notes" was 5–10× low (`77b852d`).
  > **How to apply**: a disk/memory figure in design.md shows vectors × dims × bytes (× encoding overhead).

- [ ] 📌 Follow-up: integration tests for the eight CODE-ONLY scenarios (verify.md §4) — a CLI test that drives the real `reconcileCorpus` on a temp vault with a fake embedder across two models, and a backend test that disposes during a real lock wait.
  → **Promote to** a follow-up issue
  > **Why**: those scenarios are guarded today only by a one-time manual check.
  > **How to apply**: next change that touches `cli-index.ts` or `corpus-backend.ts`.
