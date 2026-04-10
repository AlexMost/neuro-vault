# Neuro Vault MCP Design

**Date:** 2026-04-10

**Status:** Approved for planning

## Goal

Build a public npm package that exposes an MCP server over stdio for semantic search in an Obsidian vault using embeddings already produced by the Smart Connections plugin.

## Product Shape

The package ships as a CLI binary that an MCP host can launch directly:

```bash
neuro-vault-mcp --vault /absolute/path/to/vault
```

The host is responsible for starting the process. The server communicates over stdio and requires the vault path as an explicit startup argument.

## Tech Stack

- TypeScript
- Node.js
- `@modelcontextprotocol/sdk`
- `@xenova/transformers`
- ESLint
- Prettier

## Scope

### In Scope for v1

- Public npm package with a `bin` entrypoint
- MCP server over stdio
- Explicit `--vault` CLI argument
- Reading Smart Connections data from `<vault>/.smart-env/multi/*.ajson`
- In-memory semantic search over note embeddings
- Query embedding via `@xenova/transformers`
- Tools:
  - `search_notes`
  - `get_similar_notes`
  - `find_duplicates`
  - `get_stats`
- TypeScript project setup with build, lint, format, and tests
- `README.md` with installation, MCP configuration, and usage examples

### Out of Scope for v1

- HTTP or SSE transport
- Background re-indexing or live file watching
- Persistent vector database
- Query embedding cache
- Authentication or multi-user features
- Tight runtime coupling to the Obsidian app itself

## Users and Usage

Primary users are developers or knowledge workers who:

- have an Obsidian vault locally,
- already use Smart Connections,
- want to connect the vault to an MCP-capable client,
- prefer a simple install-and-configure flow through npm.

Expected setup flow:

1. Install the package globally or run it with `npx`.
2. Configure an MCP client to execute the binary.
3. Pass the vault path as CLI arguments.
4. Let the MCP server load `.ajson` files on startup.

## Architecture

The package is a single published artifact with clear internal module boundaries:

- `config`: parse and validate CLI options
- `smart-connections-loader`: discover and load `.ajson` files into memory
- `embedding-service`: initialize `@xenova/transformers` and embed free-text queries
- `search-engine`: cosine similarity and result ranking
- `tool-handlers`: MCP tool input validation and response formatting
- `server`: MCP stdio bootstrap and tool registration
- `types`: shared TypeScript types

Runtime flow:

1. Parse CLI arguments.
2. Validate vault path and Smart Connections data directory.
3. Load all note records and embeddings into memory.
4. Initialize the embedding model once at startup.
5. Register MCP tools.
6. Handle tool calls by delegating to the loader, embedding service, and search engine.

The query embedding model for v1 is the same default model family used by Smart Connections, `bge-micro-v2`, loaded through `@xenova/transformers` with mean pooling and normalized output vectors.

## Data Model

The server treats Smart Connections `.ajson` files as the source of truth.

At minimum the internal model needs:

- note identity and path
- note-level embedding vector
- note blocks or snippets used to explain results
- metadata needed for stats and error reporting

The exact Smart Connections file shape should be normalized into internal types so the rest of the code does not depend on raw JSON structure.
All tool-facing note paths should be vault-relative POSIX-style paths, so clients do not need to know the machine-specific absolute vault root.

## Tool Design

### `search_notes`

Input:

- `query: string`
- `limit?: number` default `10`
- `threshold?: number` default `0.5`

Behavior:

- embed query text through `@xenova/transformers`
- compare against loaded note embeddings
- return ranked matches above threshold

Output:

- array of `{ path, similarity, blocks }`

### `get_similar_notes`

Input:

- `note_path: string` as a vault-relative POSIX path
- `limit?: number` default `10`
- `threshold?: number` default `0.5`

Behavior:

- find the source note by path
- use its existing embedding
- search neighbors excluding the same note from results

Output:

- array of `{ path, similarity, blocks }`

### `find_duplicates`

Input:

- `threshold?: number` default `0.9`

Behavior:

- compare loaded note vectors pairwise
- return note pairs above threshold

Output:

- array of `{ note_a, note_b, similarity }`

### `get_stats`

Input:

- none

Behavior:

- report loaded corpus characteristics

Output:

- `{ totalNotes, totalBlocks, embeddingDimension, modelKey }`

## Error Handling

The server should fail fast at startup when:

- `--vault` is missing
- the vault path does not exist
- `.smart-env/multi` does not exist
- `.ajson` files cannot be loaded into a usable corpus
- the embedding model cannot be initialized

Tool handlers should return structured errors for:

- invalid arguments
- unknown note paths
- empty query strings
- internal search or embedding failures

## Packaging Decisions

- Publish as an npm package named for MCP usage
- Use ESM for modern Node compatibility
- Target active Node LTS with a documented minimum supported version during implementation
- Provide a `bin` field for direct execution
- Build to a distributable `dist/` directory
- Keep runtime dependencies minimal apart from MCP SDK and transformers

## Testing Strategy

The package should be testable without a real vault by using fixtures:

- unit tests for cosine similarity and ranking
- unit tests for loader normalization using sample `.ajson` fixtures
- unit tests for CLI config validation
- integration-style tests for tool handlers and MCP-facing behavior

The embedding service should be designed so model loading can be mocked in tests.

## Risks and Mitigations

- Smart Connections format drift:
  isolate parsing in a loader/normalizer layer and test against fixtures

- Slow first startup due to model download:
  document this behavior clearly and initialize the model once

- Large vault memory usage:
  keep v1 in-memory only and document limits rather than prematurely optimizing

- MCP host startup confusion:
  provide README examples for global install and `npx` usage

## Success Criteria

v1 is successful if a user can:

1. install the package from npm,
2. point it at an Obsidian vault with Smart Connections data,
3. start it from MCP client settings,
4. successfully call all four tools,
5. follow `README.md` to install and configure the MCP server in an MCP client,
6. get stable, explainable search results without additional infrastructure.
