# ADR-0008 — `docs/architecture/` as living per-concept documentation

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

An AI agent (and a human) working in this codebase needs to understand how a given concept works _now_ — the retrieval policy, the wikilink graph, the vault registry, the error mapping — without reverse-engineering it from source or stitching it together from a chronological trail of design specs. Design specs capture a decision at a point in time; they drift from the code as the code evolves, and reading ten of them to reconstruct current behavior is the wrong tool for "how does X work today".

## Decision

Maintain `docs/architecture/` as a set of **living, one-concept-per-file** documents describing the **current** state of the codebase. A reader must be able to understand any one concept by reading exactly one file. These are not a historical record — when the code changes, the matching architecture file is updated in the same change (an AGENTS.md rule, reinforced by `rules.design` in `openspec/config.yaml`). This is the **HOW** layer, distinct from the WHY (`docs/adr/`) and the WHAT (`openspec/specs/`).

## Consequences

- "How does X work?" has one authoritative, current answer per concept — cheap for an agent to load into context.
- Every change that alters a concept's mechanism carries a doc update; stale architecture docs are a review smell, not an accepted state.
- There is deliberate, bounded overlap with `openspec/specs/`: the architecture doc explains the mechanism, the spec states the testable contract. They update together but answer different questions (see `docs/workflow.md`).

## Alternatives considered

- **Rely on design specs only** — they are point-in-time and drift; reconstructing current behavior from them is expensive; rejected.
- **Generate docs from code** — keeps them in sync mechanically but produces reference dumps, not the "why it's shaped this way / how the pieces compose" narrative an agent actually needs.
