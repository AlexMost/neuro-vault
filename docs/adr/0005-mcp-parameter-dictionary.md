# ADR-0005 — MCP parameter dictionary: one concept = one name

- **Status**: Accepted
- **Date**: 2026-06-08

## Context

The server exposes 16 tools across two modules. Several share concepts: a vault-relative path, a path list, a subtree prefix, a wikilink identifier, a frontmatter key, a query. If each tool names these freely, the surface an LLM has to learn becomes inconsistent (`path` here, `notePath` there, `file` elsewhere), and every inconsistency is a place the model guesses wrong. Tool parameter names are a public contract: clients and prompts encode them, so a rename breaks callers.

## Decision

Maintain a single **MCP parameter dictionary** (the table in [`docs/architecture/mcp-parameter-dictionary.md`](../architecture/mcp-parameter-dictionary.md)): one concept maps to exactly one parameter name across every tool — `path`, `paths`, `path_prefix`, `exclude_path_prefix`, `name`, `key`, `query`, `filter`. New tools must reuse the dictionary name for any concept it already covers. A rename is a breaking change and **costs a major version**.

## Consequences

- The tool surface is predictable: once the LLM learns `path`, it transfers across every tool that takes a note path.
- Adding a tool is partly a lookup, not a naming decision — reducing drift.
- Changing a shared name is expensive on purpose (major bump), which keeps the dictionary stable; `rules.design` in `openspec/config.yaml` forces this to be surfaced in any change that touches a parameter.

## Alternatives considered

- **Per-tool freedom** — less coordination up front, but compounding inconsistency and a worse model-facing surface over time; rejected.
- **A code-level shared schema registry** — heavier machinery than a documented dictionary needs today; the convention + review is sufficient at 16 tools.
