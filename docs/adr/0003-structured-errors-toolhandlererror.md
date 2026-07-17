# ADR-0003 — Structured tool errors via `ToolHandlerError`

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

An MCP tool's caller is an LLM. When a tool fails, the LLM needs something it can branch on — "the note already exists, ask the user before overwriting" is actionable; a raw stderr dump is not. The underlying failure sources are heterogeneous: the `obsidian` CLI exits non-zero with human-readable stderr, handler-side validation rejects bad input before any exec, and dependency calls can throw arbitrary errors.

## Decision

Every tool error is a `ToolHandlerError` carrying a structured `{ code, message, details }` payload. Handlers validate input and throw `ToolHandlerError('INVALID_ARGUMENT', ...)` on bad input; `ObsidianCLIProvider` maps CLI failures to specific codes via `mapExecError` (`CLI_NOT_FOUND`, `CLI_TIMEOUT`, `CLI_UNAVAILABLE`, `NOTE_EXISTS`, `PROPERTY_NOT_FOUND`, `NOT_FOUND`, `CLI_ERROR`, …); unexpected dependency failures are wrapped via `wrapDependencyError` (`DEPENDENCY_ERROR`) which preserves the cause and adds operation context. The MCP server wrapper (`src/server.ts`) renders a `ToolHandlerError` into the structured client payload and anything else into a bare `{ message }`.

## Consequences

- Clients (and the LLM behind them) branch on a stable `code` instead of parsing prose. Codes are the contract; see `mcp-server-shape.md` for the wrapper. (`ObsidianCLIProvider` and its CLI-stderr mapping table described above were removed in [ADR-0009](0009-disk-direct-vault-operations.md); the `ToolHandlerError` contract this ADR establishes is unaffected and is now populated directly by `FsVaultProvider`'s `fs` error handling.)
- New error conditions require choosing/adding a code deliberately, not inventing ad-hoc strings.

## Alternatives considered

- **Return raw stderr / generic Error** — simplest, but gives the LLM nothing structured to act on; rejected.
- **A typed error subclass per condition** — more ceremony than a single error type with a `code` field, with no added branching power for the client.
