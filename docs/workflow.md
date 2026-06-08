# Workflow

How a change gets from "idea" to "merged" in this repo, and where each artifact lives. neuro-vault runs **spec-driven development on two axes** — a _spec_ axis (living capability contracts) and a _process_ axis (plan / TDD / review per change) — bridged by the `superpowers-bridge` OpenSpec schema. See [ADR-0001](adr/0001-spec-workflow-openspec-superpowers.md).

## Five locations, five questions

Each location answers exactly one question, so they don't compete:

| Location                                       | Axis                | Question                                                             | Lifecycle                                     |
| ---------------------------------------------- | ------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| [`docs/adr/`](adr/INDEX.md)                    | **WHY**             | why it is this way, could it have been otherwise                     | immutable once Accepted; supersede via Status |
| [`docs/architecture/`](architecture/README.md) | **HOW**             | how a concept works now (mechanism)                                  | living — updated with the code                |
| `openspec/specs/<cap>/`                        | **WHAT (current)**  | what a capability must do (SHALL / Scenario)                         | updated on `openspec archive`                 |
| `openspec/changes/<name>/`                     | **WHAT (proposed)** | this change's spec delta + brainstorm/design/tasks/plan/verify/retro | temporary → archived                          |
| `docs/superpowers/specs/` + `plans/`           | history             | pre-OpenSpec design+decision records                                 | **FROZEN** — do not add to it                 |

The ~30 specs under `docs/superpowers/specs/` historically blended all three live axes into one document. Going forward that blend is split: WHY → an ADR, HOW → an architecture doc, WHAT → an OpenSpec spec, with per-change reasoning in `openspec/changes/<name>/design.md`.

## Does this change need an opsx change, or a direct PR?

Process ceremony scales with risk. Routing detail: [`.claude/rules/opsx-routing.md`](../.claude/rules/opsx-routing.md).

| Scenario                                                                                                                                | Path                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| New capability / new tool / changed tool contract (input schema, output shape, MCP parameter dictionary, error codes) / breaking change | **opsx change**                                 |
| Architecture / ADR-level decision                                                                                                       | **opsx change** (the ADR is proposed inside it) |
| Bug fix (no contract change), test backfill, lint/format tweak, non-breaking dep bump, typo, docs, config value tweak, tooling setup    | **direct PR**                                   |

## End-to-end flow (opsx change)

Use the `/opsx:*` commands so the schema's artifact instructions inject at each step.

1. **Start.** `/opsx:new <slug> --schema superpowers-bridge` (or `/opsx:ff <slug>` to scaffold + run the planning artifacts in one go).
2. **brainstorm.** `superpowers:brainstorming` runs; output is redirected into `openspec/changes/<slug>/brainstorm.md` (not `docs/superpowers/specs/`).
3. **proposal / design.** Why + what-changes + capabilities (`proposal.md`); structured decisions (`design.md`). A load-bearing decision proposes a new `docs/adr/NNNN-*.md` (ask first).
4. **specs.** Delta spec per capability under `changes/<slug>/specs/<capability>/spec.md` (ADDED / MODIFIED / REMOVED / RENAMED, SHALL + `#### Scenario:`).
5. **tasks / plan.** Coarse checkboxes (`tasks.md`) + TDD micro-steps via `superpowers:writing-plans` (`plan.md`, redirected — not `docs/superpowers/plans/`).
6. **apply.** `/opsx:apply` → `superpowers:using-git-worktrees` + `superpowers:subagent-driven-development` (transitively TDD + per-task code review). See [`.claude/rules/openspec-apply.md`](../.claude/rules/openspec-apply.md).
7. **verify.** `/opsx:verify` → `verify.md`. Gates that must pass: `npm test`, `npm run lint`, `npx tsc --noEmit`.
8. **retrospective.** `retrospective.md`, written BEFORE the PR (hot context, same PR diff).
9. **archive.** `npx openspec archive -y` — syncs the delta into `openspec/specs/<capability>/` and moves the change under `openspec/changes/archive/`.
10. **PR.** `superpowers:finishing-a-development-branch` — the LAST step. Open a PR to `main`; never push directly (the release flow expects a merge commit).

## After merge: release

On `main` only, after the PR merges: `npm run release` (commit-and-tag-version, Conventional Commits) → version bump + CHANGELOG + tag → `git push --follow-tags`. Never release from a feature branch. Detail in [AGENTS.md](../AGENTS.md).
