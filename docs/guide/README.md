# Neuro Vault Guide

User documentation for the Neuro Vault MCP server. Start here if you want to know what the server can do, how to set it up, and how to use the tools it exposes.

## Pages

- **[Installation](./installation.md)** — system requirements, install via `npm` or `npx`, MCP client configuration for Claude Code / Cursor / Windsurf, first-run behavior.
- **[Semantic Search](./semantic-search.md)** — `search_notes`, `get_similar_notes`, `find_duplicates`, `get_stats`. Modes, parameters, multi-query, output examples, threshold tuning.
- **[Vault Operations](./vault-operations.md)** — `read_note`, `create_note`, `edit_note`, daily notes, frontmatter properties, tags. Parameter reference and edge cases.
- **[Routing Between Tools](./routing.md)** — when to use structural tools vs semantic search. Patterns the assistant should follow.
- **[Configuration](./configuration.md)** — CLI arguments, startup behavior, AGENTS.md / CLAUDE.md snippet, troubleshooting, limitations, development commands.

## Architecture

For internals (data flow, retrieval pipeline, module structure), see [`docs/architecture/`](../architecture/).
