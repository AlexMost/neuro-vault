# ADR-0003 — Structured tool errors via `ToolHandlerError`

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

An MCP tool's caller is an LLM. When a tool fails, the LLM needs something it can branch on — "the note already exists, ask the user before overwriting" is actionable; a raw stderr dump is not. The underlying failure sources are heterogeneous: the `obsidian` CLI exits non-zero with human-readable stderr, handler-side validation rejects bad input before any exec, and dependency calls can throw arbitrary errors.

## Decision

Every tool error is a `ToolHandlerError` carrying a structured `{ code, message, details }` payload. Handlers validate input and throw `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input; `ObsidianCLIProvider` maps CLI failures to specific codes via `mapExecError` (`CLI_NOT_FOUND`, `CLI_TIMEOUT`, `CLI_UNAVAILABLE`, `NOTE_EXISTS`, `PROPERTY_NOT_FOUND`, `NOT_FOUND`, `CLI_ERROR`, …); unexpected dependency failures are wrapped via `wrapDependencyError` (`DEPENDENCY_ERROR`) which preserves the cause and adds operation context. The MCP server wrapper (`src/server.ts`) renders a `ToolHandlerError` into the structured client payload and anything else into a bare `{ message }`.

## Consequences

- Clients (and the LLM behind them) branch on a stable `code` instead of parsing prose. Codes are the contract; see `docs/architecture/error-mapping-cli.md` for the CLI mapping table and `mcp-server-shape.md` for the wrapper.
- New error conditions require choosing/adding a code deliberately, not inventing ad-hoc strings.
- CLI stderr pattern-matching is fragile by design (it depends on a tool we do not control); the mapping table is the single canonical place to update when the CLI's wording changes.

## Alternatives considered

- **Return raw stderr / generic Error** — simplest, but gives the LLM nothing structured to act on; rejected.
- **A typed error subclass per condition** — more ceremony than a single error type with a `code` field, with no added branching power for the client.
