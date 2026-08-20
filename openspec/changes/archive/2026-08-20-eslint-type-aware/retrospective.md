# Retrospective: eslint-type-aware

> Written: 2026-08-20 (after verify passed)
> Commit range: `ef1e36b..54bdd4d`
> Worktree: `.claude/worktrees/eslint-type-aware`

---

## 0. Evidence

- **Commit range**: `ef1e36b..54bdd4d` (8 commits)
- **Diff size**: +912 / −234 lines across 53 files (42 of them the mechanical assertion-removal wave)
- **Tasks done**: 9/9 (`tasks.md` all `- [x]`)
- **Active hours**: ~1.5 (single session: propose → apply → verify)
- **Subagent dispatches**: 12 (5 implementers incl. 1 resumed fix round, 5 task reviewers, 1 re-reviewer ×2, 1 final whole-branch reviewer, 1 final fix wave)
- **New external dependencies**: `typescript-eslint@^8.67.0` (MIT, devDep); removed direct `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` (now transitive)
- **Bugs encountered post-merge**: none (pre-merge retro)
- **OpenSpec validate state at archive**: pass (12/12)
- **Test coverage signal**: vitest 1019/1019 passing, unchanged count before/after — the no-behavior-change proof

Commit chain:

```
215a547 docs(openspec): add eslint-type-aware change artifacts
be020e5 chore(deps): swap @typescript-eslint plugin+parser for the typescript-eslint meta-package
a81e6ff feat(lint): enable type-aware linting via typescript-eslint recommendedTypeChecked
5a3c421 fix(lint): clear the type-aware backlog (redundant assertions, base-to-string, empty interface)
9aa6e4d docs(openspec): record fix-round rulings and task progress
0ba2b06 docs(openspec): tick remaining task checkboxes
dd828bd docs: polish final-review minors (Node version note, defineConfig phrasing)
54bdd4d docs(openspec): correct defineConfig attribution in plan architecture line
```

---

## 1. Wins

- [evidence: §0 dispatch count; brainstorm.md §Probe] Running a probe (scratch config over `src test scripts`) BEFORE any design questions turned the whole discussion quantitative: the three user decisions (tier, test policy, plumbing) were made against measured counts (389 violations, 0 floating-promises, 31 in src), not guesses.
- [evidence: 5a3c421] The 141-assertion auto-fix wave landed with zero behavior changes — task review read all hunks and confirmed only assertion removals, two orphaned imports, prettier rewraps; test count 1019 unchanged.
- [evidence: a81e6ff task review] The task-review gate caught two real defects the implementer's self-report missed: an unauthorized scope widening (`'*.config.ts'` in disableTypeChecked) that silently un-linted `tsup.config.ts`, and a false "Deviations: None" claim. Both fixed in one round.
- [evidence: verify.md §4] Mid-flight rulings (defineConfig, vitest.config.ts→tsconfig include) were propagated to spec/design/plan at decision time, so verify found zero artifact drift.
- [evidence: task-4-report.md] The canary check proved the guard rules actually fire (`no-floating-promises`, `require-await` in src) instead of trusting config shape.

## 2. Misses

- 🟡 [painful | evidence: task-2-report.md fix round] The plan's probe never linted `vitest.config.ts` (probe ran on `src test scripts`; the config is repo-root), so the plan shipped not knowing `projectService` would fail on it. The implementer discovered it mid-task and worked around it in an unauthorized way; cost one fix round + a user interrupt. Probe scope should have been `npx eslint .` — the exact command the config will serve.
- 📌 [nit | evidence: dd828bd, 54bdd4d] Plan authored `tseslint.config(...)` without checking the helper's deprecation status in the current typescript-eslint (8.67 deprecates it); surfaced only via IDE diagnostics after the config landed, costing a ruling + two cosmetic commits.
- 📌 [nit | evidence: task-3-report.md] The plan predicted "~120" auto-fixable assertions from the 8.31-plugin probe; 8.67 found 141. The plan's own drift disclaimer covered this, but exact numbers in plans age fast.

## 3. Plan deviations

| Plan task | What changed | Why |
| --------- | ------------ | --- |
| Task 2    | + Step 1b (vitest.config.ts → tsconfig include); `tseslint.config` → `defineConfig` | Probe blind spot + upstream deprecation; both human-ruled mid-flight and recorded in plan.md |
| Task 3    | + removal of 2 orphaned type imports; prettier rewrap on 8 files | Mechanical fallout of assertion removal; disclosed by implementer, cleared by review |
| Task 5    | No commit produced | Sweep found zero stale claims — plan explicitly allowed this outcome |

## 4. Skill / workflow compliance

| Skill                                            | Used |
| ------------------------------------------------ | ---- |
| superpowers:brainstorming                        | ✓    |
| superpowers:writing-plans                        | ✓    |
| superpowers:using-git-worktrees                  | ✓ (native EnterWorktree) |
| superpowers:subagent-driven-development          | ✓    |
| (transitive) superpowers:test-driven-development | ✓/n.a. — no new tests to drive; the plan's verify-fail-first steps (expected lint failures, canary RED before green gate) carried the RED→GREEN discipline for a config-only change |
| (transitive) superpowers:requesting-code-review  | ✓ (5 task reviews, 2 scoped re-reviews, 1 final whole-branch review) |
| superpowers:finishing-a-development-branch       | ✓ (runs after archive, same session) |

### Deliberately Skipped Skills

None skipped. TDD's test-authoring step had no object (the change adds lint rules, not runtime behavior; the 1019 existing tests are the regression net), which is a schema boundary case for pure-tooling changes, not a skip.

## 5. Surprises

- `tseslint.config(...)` — the upstream-recommended entry point per our design discussion — was already deprecated in the very version we installed. Training-data-fresh "best practice" for fast-moving tooling needs a version check at plan time.
- Bringing `vitest.config.ts` into the TS project produced zero new lint hits and zero typecheck errors — the feared cost of the "clean" fix was nil.
- The relaxation set for `test/**` was validated exactly: after the auto-fix wave, tests contributed no residual violations outside the six disabled rules.

## 6. Promote candidates → long-term learning

- [ ] 🟡 Probe the exact command you will gate on, not a subset. Plan probes for lint/format/typecheck gates must run the gate's real invocation (`npx eslint .`), not a path-list approximation — path-scoped probes miss repo-root files.
      → **Promote to** memory (feedback)
      > **Why**: The `src test scripts` probe missed `vitest.config.ts`, shipping a plan with a known-wrong config and costing a fix round + user interrupt.
      > **How to apply**: When a plan's acceptance criterion is "command X exits 0", any pre-planning probe must execute command X verbatim.

- [ ] 📌 Version-check "recommended API" claims for fast-moving dev tooling at plan time (one `npm view` / changelog skim for the entry-point API).
      → **Promote to** one-off (recur once more → memory)
      > **Why**: `tseslint.config(...)` was deprecated in the exact version installed; caught late via IDE diagnostics.
      > **How to apply**: When a plan mandates a specific library entry-point API, check the latest version's deprecation state before freezing the plan text.

- [ ] 📌 Pre-commit hooks that run the gate conflict with plans that have intentionally-red intermediate commits; authorize `--no-verify` per-commit explicitly in the plan/dispatch (as done here for a81e6ff) rather than leaving implementers to improvise.
      → **Promote to** one-off — schema boundary case (single-PR plans with red midpoints are rare here; boundary because the repo's hook mirrors CI's gate by design)
      > **Why**: Task 2's commit had to fail the hook by design; the dispatch pre-authorized the bypass, which kept the implementer from either blocking or silently bypassing.
      > **How to apply**: When a plan step commits a deliberately-red state, the task brief/dispatch states the bypass authorization and its bounds explicitly.
