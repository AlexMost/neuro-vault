# Neuro Vault Guide

User documentation for the Neuro Vault MCP server. Start here if you want to know what the server can do, how to set it up, and how to use the tools it exposes.

## Pages

- **[Installation](./installation.md)** — system requirements, install via `npm` or `npx`, MCP client configuration for Claude Code / Cursor / Windsurf, first-run behavior.
- **[Finding Notes](./finding-notes.md)** — `search_notes` (hybrid semantic + lexical), `query_notes`, `get_similar_notes`, `find_duplicates`, `get_note_links`. Axes, parameters, multi-query, output examples, threshold tuning.
- **[Reading & Modifying](./reading-and-modifying.md)** — `read_notes`, `read_daily`, `create_note`, `edit_note`, frontmatter properties, tags. Parameter reference and edge cases.
- **[Routing Between Tools](./routing.md)** — when to reach for `search_notes` (and which mode), `query_notes`, or a direct read. Patterns the assistant should follow.
- **[Configuration](./configuration.md)** — CLI arguments, startup behavior, AGENTS.md / CLAUDE.md snippet, troubleshooting, limitations, development commands.

## Architecture

For internals (data flow, retrieval pipeline, module structure), see [`docs/architecture/`](../architecture/).
