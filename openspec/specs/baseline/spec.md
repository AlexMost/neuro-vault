# baseline

## Purpose

The steady state every capability change builds on: the repo's tooling, invariants, and quality gates as they exist at HEAD. This spec is intentionally thin — it records cross-cutting invariants, not per-capability behavior. Each real capability (semantic search, the individual vault-operation tools, future work like ambient retrieval) arrives in its own OpenSpec change with its own spec; nothing about those is back-filled here.

The rationale behind these invariants lives in `docs/adr/` (ADR-0002–ADR-0008); how the pieces work lives in `docs/architecture/`. This spec states them as assertable requirements.

## Requirements

### Requirement: Quality gates gate every change

The repo SHALL keep three checks green, and they MUST all pass before any commit or PR: `npm test` (full vitest suite), `npm run lint` (eslint), and `npx tsc --noEmit` (typecheck). The typecheck is authoritative for type-correctness.

#### Scenario: tsup build is not sufficient evidence

- **WHEN** a change emits cleanly under `tsup` but `npx tsc --noEmit` reports a type error
- **THEN** the change is NOT passing — `tsc --noEmit` is the source of truth, because `tsup` transpiles per-file under `isolatedModules` and does no whole-program check

#### Scenario: Test count must not silently drop

- **WHEN** a change reduces the number of passing tests
- **THEN** the drop MUST be intentional and explained, not incidental

### Requirement: Tool errors are structured

Every tool failure SHALL be surfaced as a `ToolHandlerError` carrying `{ code, message, details }`, so an MCP client can branch on a stable `code` rather than parse prose.

#### Scenario: A failure reaches the client as a code

- **WHEN** a tool handler rejects bad input, or an underlying `obsidian` CLI call or dependency fails
- **THEN** the client receives a structured `{ code, message, details }` payload (e.g. `INVALID_ARGUMENT`, `NOTE_EXISTS`, `NOT_FOUND`, `DEPENDENCY_ERROR`), not raw stderr

### Requirement: External processes are invoked without a shell

External command invocations SHALL use `execFile` with an arguments array, never `exec` with an interpolated string.

#### Scenario: A note title containing shell metacharacters is safe

- **WHEN** a tool invokes the `obsidian` CLI with a note title or value containing characters like `` ` ``, `$(...)`, or `;`
- **THEN** the value is passed verbatim as a discrete argument and is never parsed by a shell

### Requirement: Tool parameters follow one dictionary

A concept SHALL use exactly one parameter name across every tool (the MCP parameter dictionary in AGENTS.md). Renaming a shared parameter is a breaking change.

#### Scenario: A shared concept reuses its dictionary name

- **WHEN** a new or changed tool takes a concept already in the dictionary (e.g. a vault-relative path)
- **THEN** it uses the dictionary's name (`path`), and any rename of a shared name is treated as a major-version change

## Out of scope of "baseline"

- Behavior of any individual capability or tool — each has (or will get) its own `openspec/specs/<capability>/spec.md`.
- Semantic-search ranking, retrieval policy, the wikilink graph, multi-vault routing — described in `docs/architecture/`, specced per change as they evolve.
- The release process and documentation layout — recorded as conventions in AGENTS.md and ADRs, not as capability requirements.
