# Architecture

One file per architectural concept. Each file describes the **current** state of the codebase: what the concept is, why it exists, how it interacts with the rest of the system, and what it deliberately does not do.

These are living documents. Update the relevant file in the same change that alters the concept it describes.

## Concepts

- [mcp-server-shape.md](./mcp-server-shape.md) — how MCP tools are registered, response/error wrappers, resource URIs, and where the `instructions` constant lives
- [vault-conventions.md](./vault-conventions.md) — how `.neuro-vault/for-external-agents.md` reaches an agent: the `conventions` field on `get_vault_overview`, the 8,000-character cap and its truncation flag, and the pointer that is all `instructions` carries
- [tool-response-envelope.md](./tool-response-envelope.md) — the `toToolResponse`/`toToolErrorResponse` choke point: minified success text, `CODE: message` error text, client-behavior rationale
- [mcp-parameter-dictionary.md](./mcp-parameter-dictionary.md) — the cross-tool parameter naming contract (one concept = one name)
- [smart-connections-corpus.md](./smart-connections-corpus.md) — `.ajson` loader, in-memory model, no watchers
- [retrieval-policy.md](./retrieval-policy.md) — search modes, default-only threshold fallback, expansion with its own `expansion_floor` scale
- [lexical-search.md](./lexical-search.md) — `search_notes`'s lexical leg: mdast block extraction, normalization, tiered ranking, mtime cache
- [rank-fusion.md](./rank-fusion.md) — `search_notes`'s merge layer: RRF over semantic/lexical/expansion, adaptive k, tie-breaks, truncated observability
- [embedding-pipeline.md](./embedding-pipeline.md) — `@xenova/transformers` lazy initialization and value normalization
- [search-engine.md](./search-engine.md) — cosine similarity, neighbor / block / duplicate search
- [module-structure.md](./module-structure.md) — how `src/modules/{semantic,operations}/` plug into the server
- [vault-provider.md](./vault-provider.md) — the operations-module write abstraction, implemented by `FsVaultProvider` directly against the vault directory
- [vault-reader.md](./vault-reader.md) — the `FsVaultReader` abstraction for direct disk reads
- [vault-scope.md](./vault-scope.md) — the per-vault definition of which files are discoverable: dot-path/`Templates`/`.gitignore`/config exclusion layers, the `ignorePatterns` prune vs `isExcluded` predicate, and every surface it governs
- [disk-write-path.md](./disk-write-path.md) — how `create_note` writes and why `read_daily`'s Daily Notes preflight still exists, now that both are disk-direct
- [wikilink-graph.md](./wikilink-graph.md) — in-memory adjacency over `[[wikilinks]]` and `![[embeds]]`, shared across modules
- [query.md](./query.md) — the `query_notes` pipeline: tag normalisation, MongoDB-query (sift) filtering, sort/limit
- [input-coercion.md](./input-coercion.md) — how realistic stringification of MCP arguments is reshaped at the boundary, and the meaningful-error contract on coerce failure

## Reading order

If you are new to the codebase, read in this order: `mcp-server-shape` → `smart-connections-corpus` → `embedding-pipeline` → `search-engine` → `retrieval-policy` → `rank-fusion`. The first four describe the building blocks; the last two describe how they are composed — `retrieval-policy` into the semantic leg, `rank-fusion` into the unified `matches[]` list `search_notes` returns. Read `vault-scope` alongside `vault-reader` — it governs *which* files every scan-derived surface sees, before any of the above ever runs.
