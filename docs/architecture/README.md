# Architecture

One file per architectural concept. Each file describes the **current** state of the codebase: what the concept is, why it exists, how it interacts with the rest of the system, and what it deliberately does not do.

These are living documents. Update the relevant file in the same change that alters the concept it describes.

## Concepts

- [mcp-server-shape.md](./mcp-server-shape.md) — how MCP tools are registered, response/error wrappers, server instructions
- [smart-connections-corpus.md](./smart-connections-corpus.md) — `.ajson` loader, in-memory model, no watchers
- [retrieval-policy.md](./retrieval-policy.md) — search modes, threshold fallback, expansion
- [embedding-pipeline.md](./embedding-pipeline.md) — `@xenova/transformers` lazy initialization and value normalization
- [search-engine.md](./search-engine.md) — cosine similarity, neighbor / block / duplicate search
- [module-structure.md](./module-structure.md) — how `src/modules/{semantic,operations}/` plug into the server
- [vault-provider.md](./vault-provider.md) — the operations-module abstraction over the Obsidian CLI
- [vault-reader.md](./vault-reader.md) — the `FsVaultReader` abstraction for direct disk reads (decoupled from the Obsidian CLI)
- [query.md](./query.md) — the `query_notes` pipeline: tag normalisation, MongoDB-query (sift) filtering, sort/limit
- [error-mapping-cli.md](./error-mapping-cli.md) — Obsidian CLI stderr → structured `ToolHandlerError` codes
- [input-coercion.md](./input-coercion.md) — how realistic stringification of MCP arguments is reshaped at the boundary, and the meaningful-error contract on coerce failure

## Reading order

If you are new to the codebase, read in this order: `mcp-server-shape` → `smart-connections-corpus` → `embedding-pipeline` → `search-engine` → `retrieval-policy`. The first four describe the building blocks; the last describes how they are composed.
