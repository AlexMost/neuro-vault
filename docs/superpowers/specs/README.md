# Frozen — pre-OpenSpec design specs

This directory is the **historical record** of design decisions made before neuro-vault adopted OpenSpec (see [ADR-0001](../../adr/0001-spec-workflow-openspec-superpowers.md), 2026-06-08). The specs here remain readable and are not migrated — but **nothing new is added**.

Going forward, the three things these documents used to blend together each have a durable home:

| You're looking for…                                       | Now lives in                                         |
| --------------------------------------------------------- | ---------------------------------------------------- |
| **Why** a decision was made                               | [`docs/adr/`](../../adr/INDEX.md)                    |
| **How** a concept works now                               | [`docs/architecture/`](../../architecture/README.md) |
| **What** a capability must do (current contract)          | `openspec/specs/<capability>/`                       |
| A change in flight (delta + brainstorm/design/tasks/plan) | `openspec/changes/<name>/`                           |

The full map and routing rules are in [`docs/workflow.md`](../../workflow.md). New design output from `superpowers:brainstorming` / `writing-plans` is redirected into `openspec/changes/<name>/` by the `superpowers-bridge` schema — it must not land here.

`docs/superpowers/plans/` (gitignored) is likewise frozen.
