# Retrospective: single-vault-dispatch-builder

> Written: 2026-08-30 (after verify passed, before the PR was opened)
> Commit range: `3ceb616..437f7e1` on `feat/single-vault-dispatch-builder` — one PR
> Tracking issue: [#111](https://github.com/AlexMost/neuro-vault/issues/111)

---

## 0. Evidence

- **Diff size**: +1 578 / −242 lines across 26 files; excluding the planning artifacts, +521 / −242 across 19 source, test, config, and doc files.
- **Tasks done**: 13/13 (`tasks.md`), 32/32 plan steps.
- **Deliverables**: seven commits — builder + gate-routed tests, the seven operations migrations, the two semantic migrations, the composition cleanup, the ESLint boundary, the docs sweep, and the registered-description prose guard.
- **Test coverage signal**: 108 files / 1 347 tests, 0 failures (from 107 / 1 342 at `3ceb616`). `npm run lint`, `npm run typecheck`, `npm run build`, and `prettier --check` all clean at every commit.
- **Acceptance grep**: `resolveVault\|resolveSemanticVault\|vaultParamShape\|describeMultiVault\|EXPLICIT_VAULT_SUFFIX` across `src/modules/` returns one hit — a prose comment in `search-notes.ts:128`. Zero imports. The 27 hand-rolled repetitions the design counted are gone.
- **Prose preservation**: a throwaway `describe-dump.ts` rendered all 14 registered descriptions whitespace-normalized against `origin/main`'s `src/` and against this branch. The diff is exactly one line — `create_note` — as designed (D4). The other 13 are word-identical.

---

## 1. Wins

- **The invariant became structural, and then got a second, independent guard.** `buildSingleVaultTool` makes suffix-last unbreakable by construction, and `explicit-vault-prose.test.ts` pins it on the nine *registered* descriptions — the artefact a client actually receives. The two guards fail for different reasons: the builder can't be bypassed, and the test would catch a tenth tool that skipped the builder entirely.
- **The word-wise diff against `main` was worth more than any test.** "Only joining whitespace may change" is exactly the class of claim a green suite cannot confirm — the tests use `toContain` and `toMatch`, which are separator-agnostic by design. Rendering all 14 descriptions twice and diffing them turned a promise into a one-line proof.
- **Deleting the separator heuristic was cheap because its call sites moved with it.** `describeMultiVault`'s return contract, both builders, and both exact-string test files changed in one commit. Splitting that across tasks would have made the typecheck gate unsatisfiable at the boundary.
- **The ESLint probe used the verbatim gate command.** Adding a real `resolveVault` import to `remove-property.ts` and running `npm run lint` — not a path-scoped `eslint src/modules` — proved the boundary fires as CI will run it.
- **The type-level `vault?: never` guard carried over from `buildMultiVaultTool` unchanged.** Mirroring an existing spec shape meant the new builder needed no new ideas, only a new discriminant.

## 2. Misses

- **The first `describe-dump.ts` run silently produced 14 empty descriptions.** `buildOperationsTools` returns *registrations*, not `ITool`s, so `t.description` is `undefined` and `t.spec.description` is the real field. The diff came back clean — the most dangerous possible wrong answer for a check whose entire job is to detect a difference. Only the `grep -c "Registered vaults"` sanity count caught it. A dump script needs a non-zero assertion on its own output before its diff is trusted.
- **The first baseline was taken against the wrong tree.** `git stash -u` on a fully-committed working tree stashes nothing, so the "before" dump ran against the branch, not `main`. `git checkout origin/main -- src/` is the honest way to render a baseline in place. The plan prescribed the stash dance; it does not work when every task has already been committed.
- **The plan had no task for the registered-description guard.** The spec scenario says "*every registered* explicit-vault tool", which the builder-level test structurally cannot observe — it builds fake tools. The gap was found at verify, not at plan time.

## 3. Plan deviations

| Deviation | Why |
| --- | --- |
| Added `test/lib/explicit-vault-prose.test.ts` (not in the plan) | The spec's suffix-last scenario is a property of the nine registered descriptions; the builder-level test asserts it only for fakes. Probed against `origin/main`'s `create-note.ts`, where it fails — so it guards rather than restates. |
| Task 2 Step 5 ("fix any assertion the migrations surface") was a no-op | No exact-string or ordering assertion existed for the nine tools' descriptions. The full suite went green on the migrations untouched — which is itself the evidence the plan wanted from that step. |
| `describe-dump.ts` used an inline registry stub, not the test helpers | `test/**/_helpers` import `vitest`, which throws outside a test runner. A five-line `IVaultRegistry` literal is enough: rendering descriptions never runs a handler. |
| `docs/architecture/semantic-backend.md` was edited (the plan named only `fan-out.md`) | Its `resolveSemanticVault` sentence became imprecise once the resolver moved behind the builder. One clause, plus a cross-reference. |
| `docs/adr/0010` was left unedited despite a stale `describeMultiVault` sentence | ADRs are immutable records; the reference is not broken, and `fan-out.md` now carries the current mechanism. |
| Implemented directly rather than through `superpowers:subagent-driven-development` | The session's own instructions forbid dispatching subagents unless the user asks. TDD order (RED → GREEN → gates → commit) was followed by hand on both new test files. |

## 4. Skill / workflow compliance

- Worked in a git worktree throughout; never `cd`'d into the main checkout.
- `npm test && npm run lint && npm run typecheck` green before every one of the seven commits; `npm run build` added at the final gate.
- Every commit carries the `Co-Authored-By: Claude Fable 5` trailer.
- The change directory was untracked on `main`, so the planning artifacts were copied into the worktree and committed with Task 1 — otherwise the PR would have carried an implementation with no spec.
- Verify ran before the retrospective, and both land in this PR ahead of archive.

## 5. Surprises

- **Nine tools migrated with zero test edits.** The suite went from 1 342 to 1 343 passing (the one addition being a new `vault-param` assertion) without a single existing test needing to change. The descriptions were never pinned exactly anywhere — which is precisely why `create_note`'s suffix-order bug survived long enough to be found by reading, not by failing.
- **The bug the change was named for was invisible to every gate.** `create_note` put prose after the vault contract text and `get_note_links` buried the suffix inside a `.join('\n')` element. Both compiled, linted, typechecked, and passed 1 342 tests. Only rendering the finished description and looking at its last sentence surfaces that class of defect.

## 6. Promote candidates → long-term learning

- **A diff-based check needs a positive assertion on its own output first.** A comparison script that renders nothing produces a clean diff, and a clean diff reads as success. Count the thing you expect to find before trusting the absence of a difference.
- **`git stash -u` is not a baseline mechanism for a committed branch.** To render "before", check the old tree into the worktree (`git checkout <ref> -- <path>`) and restore afterwards.
- **When a spec scenario says "every registered X", ask what artefact carries the property.** A builder-level test proves the builder; only a test over the real registration list proves the registry. If those two differ, the plan needs both.
