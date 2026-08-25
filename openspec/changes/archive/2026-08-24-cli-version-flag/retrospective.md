# Retrospective: cli-version-flag

> Written: 2026-08-24 (after verify passed)
> Commit range: `c3448df..c81bdc6`
> Worktree: `/Users/amostovenko/git/neuro-vault/.claude/worktrees/cli-version-flag` (branch `worktree-cli-version-flag`)

---

## 0. Evidence

- **Commit range**: `c3448df..c81bdc6` (5 commits)
- **Diff size**: +223 / −26 lines across 11 files (4 source, 3 test, 3 docs, 1 CI)
- **Tasks done**: 17/17
- **Active hours**: ~1.0h wall clock for apply (worktree setup through final re-review); planning was a separate earlier pass
- **Subagent dispatches**: 11 — 5 implementers (Tasks 1–5), 4 task reviewers (Tasks 1–4), 1 final whole-branch reviewer, 1 fix-wave implementer + 1 scoped re-reviewer (12 counting the re-reviewer separately)
- **New external dependencies**: none — yargs already ships `.version()`
- **Bugs encountered post-merge**: none (not yet merged)
- **OpenSpec validate state at archive**: pass — 13 items, 0 invalid
- **Test coverage signal**: vitest 1062 passing / 86 files, up from 1056 / 85 at baseline (+6 tests, +1 file)

Commit chain:

```
c3448df chore(release): 15.4.0                                    (branch point)
9fbdfde refactor: read package.json from one module
7bfb0c9 feat(cli): add --version and stop --help falling through
85a32ce fix(cli): exit 0 on --version and --help without starting the server
34d725a docs: describe CLI startup and document --version
c81bdc6 test(cli): close review gaps in --version smoke coverage
```

---

## 1. Wins

- **Probing the real parser before planning removed every unknown from the plan.** Three empirical probes against this repo's yargs 18 established that `.version(str)` emits exactly one `console.log(str)`, that `argv.help`/`argv.version` are set only when the flag fires, and that `--help` is likewise a single `console.log`. The plan's test assertions were written directly from those observations, and none needed adjustment during implementation. Contrast with the usual failure mode of planning against remembered library behaviour.
- **A one-line request surfaced a second, live defect.** The user asked only for `--version`. Reading `src/config.ts:67` showed `.version(false)` plus `.exitProcess(false)`, and running the binary showed `--help` printing the help text and then `--vault is required` with exit 1. Both flags shared one root cause; fixing them together cost three lines more than fixing one.
- **Making the state representable, rather than patching the symptom.** `ParsedCli` (`src/config.ts:38`) converts "the CLI ended without a config" from unrepresentable into a variant the compiler forces every call site to handle. The final review's judgement: `src/cli.ts:15-17` now cannot reach `startNeuroVaultServer` without narrowing. The alternative (`ServerConfig | null`) was rejected in design D4 precisely because a nullable return invites a `!` that silently restores the bug.
- **The final review earned its seat.** Four task reviews passed clean; the whole-branch review still found a real Important issue no task-scoped reviewer could see — CI ran `npm run build` but never executed the result (§2 🟡 below). It also independently re-probed yargs across twelve invocations, confirming `--no-version` and `--version=false` correctly fall through because the check is strict `=== true`.
- **The build-output check caught nothing — and that is the win.** `node dist/cli.js --version` printed `15.4.0` on the first try, confirming the `src/`-root-depth reasoning for `package-meta.ts` held in the flattened bundle. The check was cheap to run and would have been the only signal had the reasoning been wrong.

## 2. Misses

- 🟡 **[painful]** The plan specified the build-output check as a manual step (Task 5.2) and never asked whether CI should enforce it — even though the spec's Requirement 3 explicitly says the module's location "MUST be verified against the build output, not only against source-level tests." A one-time manual act does not satisfy a MUST that describes an ongoing property. The final review caught it; `c81bdc6` added the CI step. Writing a spec clause that says "MUST be verified" should trigger the question "verified once, or on every push?" at plan time.
- 🟡 **[painful]** The plan's task boundary between Tasks 2 and 3 was drawn one file too narrow. Changing `parseConfig`'s return type breaks `src/cli.ts` compilation, and Task 2's own gate requires `npm run typecheck` to pass — so Task 2 could not be committed without also making Task 3's source edit. The consequence was worse than the untidiness: Task 3's RED step became impossible as written, and the implementer had to establish RED by temporarily disabling the fix. A type change and its call-site update are not separable across a commit boundary when the gate is a typecheck.
- 📌 **[nit]** Commit `85a32ce` is typed `fix(cli)` but its content is test-only, the behavioural fix having landed in `7bfb0c9`. Harmless here — the repo squash-merges, so `commit-and-tag-version` never sees it — but the commit type was copied from the plan's suggested message without re-checking it against what the commit actually contained.
- 📌 **[nit]** Nobody updated `tasks.md` checkboxes during apply; all 17 were still `- [ ]` when the verify precheck demanded them. Caught by the precheck rather than by the loop that was supposed to maintain them.
- 📌 **[nit]** The Task 3 implementer's report overstated its RED evidence, describing a failure via the `serverFactory` assertion when the captured trace actually showed an uncaught `TypeError` inside `VaultRegistry.create` reached first. The evidence was genuine; the narration was not checked against it.

## 3. Plan deviations

| Plan task | What changed | Why |
|---|---|---|
| 3 Step 3 (`src/cli.ts` narrowing) | Landed in Task 2's commit `7bfb0c9` instead | Changing `parseConfig`'s return type breaks `cli.ts` compilation; Task 2's gate requires `npm run typecheck` to pass, so it could not be committed without the call-site fix. Ruled sound by the final review. |
| 3 Steps 1–2 (RED) | RED established by temporarily disabling the early return, capturing the failure, restoring, then capturing GREEN | Consequence of the deviation above: with the fix already present the new test passed on arrival, and a regression test never observed to fail proves nothing. |
| 5 Step 4 (backgrounded server check) | Run as a timed stdin-pipe equivalent instead of `&` + `kill %1` | The session's worktree guard rejects compound shell commands; job control was an incidental mechanism, not the requirement. The assertion (process does not exit immediately) was unchanged. |
| 5 Step 6 (`gh pr create`) | Deferred out of the task | The opsx apply sequence requires verify → retrospective → archive before the PR, so a PR opened inside Task 5 would carry an incomplete cycle. |
| — (new) | CI smoke step for the built binary | Final-review Important finding; see §2. |

## 4. Skill / workflow compliance

| Skill | Used |
|---|---|
| superpowers:brainstorming | ✓ |
| superpowers:writing-plans | ✓ |
| superpowers:using-git-worktrees | ✓ |
| superpowers:subagent-driven-development | ✓ |
| (transitive) superpowers:test-driven-development | ✓ |
| (transitive) superpowers:requesting-code-review | ✓ |
| superpowers:finishing-a-development-branch | ✓ (invoked immediately after this retro + archive) |

### Deliberately Skipped Skills

None — every apply-phase skill in this schema ran.

One sub-step was deliberately not dispatched: Task 5 received no task-scoped code review, because it produces no diff (it runs read-only gates and reports evidence) and a diff-scoped reviewer would have had nothing to read. Its output was instead consumed by verify.md §0 and by the final whole-branch review, both of which did scrutinise it. Recorded as a ruling during apply rather than a silent omission.

## 5. Surprises

- **`.version(false)` was a switch, not a decision.** The expectation going in was that disabling the version flag reflected some deliberate constraint worth understanding. `git log -S` traced it to `a6e0ae2` ("feat: use yargs for CLI arg parsing with --help support"), where it was switched off alongside the rest of the yargs defaults, with no ADR and no commit-message rationale. There was nothing to overturn — only a decision nobody had made.
- **`--help` was already broken in production.** The intent was to add a flag; running the binary first revealed the neighbouring flag was emitting a spurious error and a non-zero exit. It had presumably been that way since `a6e0ae2`.
- **The path-depth constraint is invisible to the entire test suite.** 1062 tests, eslint, and `tsc --noEmit` would all stay green with `src/package-meta.ts` moved one directory deeper, while the published package would throw at load on every invocation — because `src/server.ts` imports it at module scope. A correctness property with zero coverage from the repo's whole gate stack was not something the design anticipated needing a CI step for.
- **A cheap model handled the mechanical tasks without a single fix round.** Tasks 1–3 ran on haiku from briefs containing complete code, and all three passed their reviews clean on the first pass. The one fix wave came from the final whole-branch review, not from implementer error.

## 6. Promote candidates → long-term learning

- [ ] 🟡 **A spec clause saying "MUST be verified" needs a home in CI, not just a checklist row**
  → **Promote to** memory (feedback)
  > **Why**: this cycle's spec Requirement 3 demanded verification against the build output; the plan satisfied it as a one-time manual step, leaving a correctness property that the entire gate stack (1062 tests, eslint, tsc, even a successful build) cannot catch. The final review had to add the CI step.
  > **How to apply**: when writing a spec requirement containing "MUST be verified" or naming a property that source-level tests cannot observe, decide at plan time whether the check belongs in CI, and make that a task rather than a verification step.

- [ ] 🟡 **A type change and its call-site updates cannot be split across tasks when the gate is a typecheck**
  → **Promote to** memory (feedback)
  > **Why**: the plan put `parseConfig`'s return-type change in Task 2 and its `src/cli.ts` call-site fix in Task 3, but Task 2's gate requires `npm run typecheck` to pass — making the split unsatisfiable. It also destroyed Task 3's ability to demonstrate RED honestly.
  > **How to apply**: when slicing a plan, put a signature or return-type change in the same task as every call site it breaks. If the plan's own gate is a typecheck, a task that leaves the tree non-compiling is not a task.

- [ ] 📌 **Verify the commit type against what the commit actually contains, not against the plan's suggestion**
  → **Promote to** memory (feedback)
  > **Why**: `85a32ce` shipped as `fix(cli)` while containing only a test, because the implementer used the plan's suggested message verbatim after the behavioural fix had migrated to an earlier commit. Under a merge-commit strategy this would have produced a wrong CHANGELOG entry.
  > **How to apply**: before committing, re-read the staged diff and confirm the conventional-commit type matches it — a test-only commit is `test:`, regardless of what the plan proposed.

- [ ] 📌 **Update `tasks.md` checkboxes as each coarse task completes, not at the verify precheck**
  → **Promote to** schema / controller discipline
  > **Why**: all 17 boxes were still unchecked when the verify precheck demanded them, even though the apply instruction tells the executor to maintain them. The ledger tracked progress correctly; `tasks.md` silently did not.
  > **How to apply**: fold the `tasks.md` checkbox update into the same controller step that appends the `Task <N>: complete` ledger line, so the two cannot drift.

- [ ] 📌 **An implementer's narration of its own test evidence needs checking against the captured output**
  → **Promote to** skill (task-reviewer prompt)
  > **Why**: the Task 3 report described a RED failure via the `serverFactory` assertion; the captured trace actually showed an uncaught `TypeError` reached earlier. The reviewer caught it only because it traced the stack itself.
  > **How to apply**: when a report claims RED evidence, compare the claimed failure mode against the pasted output before accepting it — the output is the evidence, the prose around it is a claim.
