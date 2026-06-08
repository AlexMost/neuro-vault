# ADR-0001 — Spec workflow: OpenSpec + superpowers-bridge

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

neuro-vault already runs the **process axis** of spec-driven development — the Superpowers skill chain (brainstorming → writing-plans → subagent-driven-development → finishing-a-development-branch) — leaving a committed design spec per change in `docs/superpowers/specs/`. What it lacks is a **spec axis**: a living, per-capability source of truth for what each tool/capability does now, evolved by readable requirement-level deltas rather than re-derived from code on every change. The open risk is that neuro-vault is not a blank slate — it already has `docs/architecture/` (living mechanism docs) and 30+ historical design specs — so a spec layer must add value over what exists, not duplicate it.

## Decision

Adopt **OpenSpec** (`@fission-ai/openspec`, a dev-only tool) with the published **`superpowers-bridge`** schema, mirroring the `~/git/svadlenka-crm` setup. The bridge wires OpenSpec's artifact governance (the _what_) to Superpowers' execution skills (the _how_) entirely at the prompt layer, and adds an evidence-first `retrospective` artifact. Each capability change runs as an opsx change under `openspec/changes/<name>/` (brainstorm → proposal → design → specs → tasks → plan → verify → retrospective), with the spec delta synced into `openspec/specs/<capability>/` on archive.

This is itself a deliberate experiment (the second SDD polygon after the Moby Dick bot, the first on a real TS codebase) — whether OpenSpec becomes the default flow for capability work is the _output_ of pilot changes, not settled by this ADR.

## Consequences

- Five doc/spec locations coexist by altitude — WHY (`docs/adr/`), HOW (`docs/architecture/`), WHAT-now (`openspec/specs/`), WHAT-proposed (`openspec/changes/`), and the FROZEN pre-OpenSpec record (`docs/superpowers/specs/` + `plans/`). Full map in `docs/workflow.md`.
- The bridge redirects brainstorm/plan output into the change directory, so `docs/superpowers/specs/` and `plans/` stop accruing new files (frozen, not migrated).
- The adoption itself (tooling setup) is a direct PR, not an opsx change — OpenSpec cannot run before it exists, and the schema's own rules route tooling setup to direct PR.
- Apply phase requires a subagent-capable platform; there is no manual fallback within the schema (use the built-in `spec-driven` schema if subagents are unavailable).

## Alternatives considered

- **Superpowers alone (status quo)** — works, but each change's design spec is orphaned after merge; no living per-capability contract.
- **OpenSpec alone** — a living spec layer, but loses the brainstorm/TDD/review discipline the Superpowers chain already provides.
- **Vanilla `spec-driven` OpenSpec schema** — no bridge to Superpowers; reintroduces manual per-step skill orchestration the `superpowers-bridge` schema removes.
