# Retrospective — `conventions-overview-only`

**Date**: 2026-08-24
**Tracking issue**: #93

---

## 0. Evidence

| Metric | Value |
| --- | --- |
| Commit count | 4 (`origin/main..HEAD`) |
| Diff size | 19 files, +1,325 / −290 |
| Production code touched | 2 files — `src/server.ts` (−51/+ constant), `src/lib/obsidian/vault-conventions.ts` (comment only) |
| Tasks done | 32 / 33 (the remaining one is the PR that archive precedes) |
| Active duration | ~35 minutes, single session |
| Subagent dispatches | **0** — see §4 |
| New external dependencies | 0 |
| Post-merge bugs | n/a (not yet merged) |
| OpenSpec validate at archive | 13 passed, 0 failed |
| Test signal | 1051 passed / 0 failed, 85 files. Suite net −5 tests: 10 deleted, 5 added. |
| `SERVER_INSTRUCTIONS` length | 936 characters — exactly design D4's prediction (693 + 241) |

**Commit chain**

```text
b5905c0  refactor(server): make MCP instructions a vault-independent constant
6e5e9a4  docs(adr): record why conventions leave the instructions channel (ADR-0012)
55311a8  docs: drop the instructions channel from the conventions story
7b96110  docs(architecture): drop the stale instructions-ordering claim from the map
```

---

## 1. Wins

- **The plan caught an error in its own tasks.md before implementation could act on it.** `tasks.md` 1.5 said to delete the `readVaultConventions` import from `src/server.ts`. `plan.md` step 5 contradicted it with a bolded **Careful** block: the symbol is still consumed at `src/server.ts:86` by `conventionsReaderFactory`, feeding `IVaultEntry.readConventions` for the overview channel. Following the plan over the task list avoided breaking `get_vault_overview` in the foundation commit. The plan author had verified the claim against the source; the task author had not.

- **The design's measurement was exact, not approximate.** D4 predicted 936 characters. The implemented constant measures 936. A design that predicts a number to the character is a design whose author actually composed the string rather than estimating it.

- **The repo-wide sweep earned its place in the plan.** Task 5.1 explicitly said "a doc sweep scoped to `docs/architecture/` alone misses the guide layer — cover all of `docs/`". It found `docs/architecture/README.md:10` still advertising "the `instructions` ordering and 2048-character budget" — a file on none of task 4's six named paths. Without the whole-repo sweep as its own task, acceptance criterion 4 would have been claimed and been false.

- **Scope containment was made falsifiable rather than asserted.** Task 2 step 5 named four overview-channel test files and made *any* edit to them a stop condition. All 36 tests passed with zero edits, which converts "the overview channel is untouched" from a claim into an observation.

- **RED was verified before GREEN on every code task.** The four new tests failed with the exact expected error (`SERVER_INSTRUCTIONS` undefined / not a function) before `src/server.ts` was touched. The old suite then failed for the right reason — the deleted export — rather than silently passing against a stale build.

- **The change deletes more concept than code.** 51 lines out of `src/server.ts` remove a composition loop, an async signature, a registry dependency, a per-vault heading rule, and an ordering invariant. The replacement has no inputs, so the spec scenario "the string does not vary with the registry" is enforced by the type system rather than by a test.

---

## 2. Misses

- 🟡 **`tasks.md` and `plan.md` disagreed on a load-bearing detail, and only one of them was right.** Task 1.5 instructed deleting an import that is still consumed 60 lines later. Both artifacts were generated in the same cycle from the same design; the plan verified the claim against `src/server.ts` and the task list did not. An executor reading only `tasks.md` — which is exactly what `openspec instructions apply` returns first — would have broken the overview channel and found out at typecheck, or worse, not at all if the unused-import rule had been off. The task list is the *more* consulted artifact and got the *less* verified content.

- 🟡 **The schema's mandated executor could not run, and the conflict was only discoverable at apply time.** `superpowers-bridge`'s apply instruction hard-requires `superpowers:subagent-driven-development` and says a platform without subagent support should use the `spec-driven` schema instead. This session's configuration forbids the Agent tool absent an explicit user request. Neither `/opsx:propose` nor plan authoring surfaces that constraint; it fired only after the worktree was created and the context files read. The user resolved it in one question, but the cost is that a schema choice made at `propose` time is validated at `apply` time.

- 📌 **`docs/adr/0010-context-delivery-channels.md` now contains two sentences that read as current and are not.** Lines 28 and 31 describe conventions travelling on both channels and call the duplication accepted. Correct to leave — ADRs are immutable under ADR-0008, and ADR-0012 states the relationship explicitly — but a reader landing on ADR-0010 from the INDEX has no in-file signal that a later ADR revised it. The INDEX marks supersession in the Status column; a *revision* that is not a supersession has no marker at all.

- 📌 **The plan's step-6 verification command targeted a build artifact that does not exist.** `node -e "import('./dist/server.js')…"` — `tsup` bundles to `dist/cli.js` only. Substituted `npx tsx -e "import('./src/server.ts')…"`, which measures the source of truth anyway. A one-line drift in a command written but never run.

---

## 3. Plan Deviations

| Task | Planned | Actual | Why |
| --- | --- | --- | --- |
| 1 + 2 | Two commits, with the tree left red between them | One commit (`b5905c0`) | Task 1 step 7 explicitly expects the old suite red at that point. The repo's Global Constraint — "`npm test`, `npm run lint`, `npm run typecheck` must all pass before any commit" — governs, so the pair merged. Both tasks' substance delivered in full. |
| 1.5 | Delete the `readVaultConventions` import | Import kept | Still consumed at `src/server.ts:86`. `plan.md` step 5 flagged this; task list was wrong. See §2. |
| 4.5 | Fix `docs/architecture/obsidian-lib.md` line 49 if it credits `buildServerInstructions` | Line 49 left as-is | It credits only the registry wiring, which is unchanged. Task text already scoped this as conditional. |
| 5 | Read-only sweep | One edit (`7b96110`) | The sweep found a real defect outside task 4's file list. Task 5's own text anticipated this ("Modify: any file the sweep turns up that Tasks 1–4 missed"). |
| Ordering | Plan ends at task 7.4 = PR | verify → retrospective → archive → PR | The schema's apply instruction overrides the plan's tail, so the PR diff carries the complete archived cycle. |

---

## 4. Skill / Workflow Compliance

| Skill | Used | Note |
| --- | --- | --- |
| `superpowers:using-git-worktrees` | ✓ | Step 0 detection run (`GIT_DIR` vs `GIT_COMMON`, submodule guard). Native `EnterWorktree` used per step 1a rather than `git worktree add`. Baseline confirmed green (1056 tests) before any edit. |
| `superpowers:subagent-driven-development` | ✗ | See below. |
| `superpowers:test-driven-development` | ✓ | Applied directly rather than transitively. RED verified with actual failure output before each GREEN; no implementation code preceded a failing test. |
| `superpowers:requesting-code-review` | ✗ | See below. |
| `superpowers:finishing-a-development-branch` | ✓ | Invoked for the PR step. |

### Deliberately Skipped Skills

**1. `superpowers:subagent-driven-development`**

- **What was skipped**: the whole executor — per-task fresh subagents in the worktree.
- **Why this cycle**: not a judgment call. This session's system prompt carries the literal directive *"Do not call the AgentTool unless the user requested it"*, which contradicts the schema's apply instruction requiring subagent dispatch. The conflict was surfaced to the user before any file was touched, via `AskUserQuestion` offering (a) direct in a worktree, (b) subagent-driven with explicit Agent-tool authorisation, (c) direct on a branch without isolation. The user selected (a). Recorded in `verify.md` §2 as well, so it is visible to an archive reviewer who never reads this file.
- **How to prevent recurrence**: **schema graph fix.** The bridge's apply instruction already has a pre-flight step 0 that checks whether the required *skills* are installed. It has no check for whether the harness permits the *tool* those skills depend on. Extend pre-flight to probe Agent-tool availability, and route to the documented `spec-driven` fallback — or prompt — before the worktree is created, rather than after. Alternatively `/opsx:propose` should record the executor choice at schema-selection time, since that is when the schema is picked.

**2. `superpowers:requesting-code-review`**

- **What was skipped**: the per-task and final code-reviewer subagent passes.
- **Why this cycle**: purely transitive — this skill reaches the flow only *through* `subagent-driven-development`, and a code-reviewer subagent is a subagent. Same directive, same root cause as (1); not an independent decision.
- **How to prevent recurrence**: same schema fix as (1). Worth noting that the compensating controls here were unusually strong for a change this size — the diff touches 2 production files, one of which is a comment; the four gates all ran verbatim; and every acceptance criterion was checked against command output. That does not substitute for adversarial review of the *pointer's wording*, which is the one thing in this change no test can assess. If the fix in (1) lands, this row disappears with it.

**Pattern signal**: both skips share one root cause and one prevention. That is a §6 promote candidate, not two.

---

## 5. Surprises

- **The old test suite was structurally unable to catch the bug it existed to prevent.** Known going in from the design's "asymmetric CI guard" finding, but seeing it concretely was sharper: `representativeConventions()` built a 1,227-character fixture and the suite varied only the preamble. The free variable in production — the vault owner's file — was the pinned constant in CI, and the pinned constant in CI — the preamble — was the thing nobody edits. The suite tested the axis that does not move.

- **Deleting the composition made a spec scenario unwritable, and that was the right outcome.** "The string does not vary with the registry" was meant to be tested by composing two registries and diffing. Once the export takes no registry, there is nothing to compose twice. The plan's Self-Review had already anticipated this and called the impossibility *the* guarantee. Rare for a spec scenario to be satisfied by becoming inexpressible.

- **The pointer paragraph came out of the design fully formed.** D4 fixed the required content and left "exact wording settled during implementation" as an open item — but the plan's step 5 already contained a drafted sentence measuring exactly the predicted 241 characters. The open question had been closed in the plan without being marked closed in the design.

---

## 6. Promote Candidates → Long-term Learning

- [ ] 🟡 **A harness that forbids the Agent tool silently breaks any schema whose apply phase mandates subagents — and the break surfaces only at apply time.**
  → **Promote to** schema (`superpowers-bridge` apply pre-flight)
  > **Why**: `superpowers-bridge` step 0 verifies the required *skills* are installed but not that the harness permits the *tool* they run on. This cycle the conflict fired after the worktree existed and six context files were read. The documented remedy ("use `spec-driven` instead") is only actionable at propose time, which has already passed by then.
  > **How to apply**: when authoring or reviewing an apply-phase pre-flight, check tool availability alongside skill availability, and put the schema-choice escape hatch where the schema is still choosable.

- [ ] 🟡 **When `tasks.md` and `plan.md` disagree about code, trust `plan.md` — and verify against the source before either.**
  → **Promote to** memory (feedback)
  > **Why**: task 1.5 told the executor to delete a still-consumed import (`readVaultConventions`, used at `src/server.ts:86`); `plan.md` step 5 flagged it correctly because its author had read the file. `openspec instructions apply` returns the task list first, so the less-verified artifact is the more-consulted one.
  > **How to apply**: during any opsx apply, when a task says "delete X", grep X in the target file before deleting. When the two artifacts conflict, follow the plan and note the discrepancy in verify.md rather than silently picking one.

- [ ] 📌 **A test whose fixture pins the variable that moves in production is a guard in name only.**
  → **Promote to** memory (feedback)
  > **Why**: `test/server-instructions.test.ts` pinned a 1,227-character conventions fixture and varied only the preamble. The vault owner's file was free in production and constant in CI — which is precisely how the broken delivery shipped and stayed shipped.
  > **How to apply**: when writing a budget or size guard, ask which input a third party controls. If the test pins that input and varies one you control, the assertion is inverted — assert an invariant that party cannot break, or vary their input.

- [ ] 📌 **An ADR revised-but-not-superseded by a later ADR has no marker anywhere.**
  → **Promote to** one-off (`docs/adr/INDEX.md` convention) — **boundary case**: it is a repo documentation convention, not a workflow rule, and it affects exactly one row today.
  > **Why**: ADR-0010 lines 28 and 31 now describe behaviour ADR-0012 removed. Immutability (ADR-0008) is correct and ADR-0012 states the relationship, but a reader entering from the INDEX gets no signal. The INDEX's Status column handles supersession and has no vocabulary for partial revision — though row 0001 already improvises one ("superseded in part by 0011"), so the need has appeared twice.
  > **How to apply**: if a third ADR needs it, formalise a "Revised in part by NNNN" status form rather than improvising per row.
