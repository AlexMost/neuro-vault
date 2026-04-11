# Neuro Vault MCP

Neuro Vault MCP is a Model Context Protocol server for semantic search over an Obsidian vault that already has Smart Connections embeddings and note data on disk. It reads Smart Connections `.smart-env/multi/*.ajson` files, loads the corpus into memory, and exposes MCP tools over stdio so compatible clients can search the vault without extra infrastructure.

## Overview

The server is started by an MCP host or from the command line with an explicit vault path:

```bash
neuro-vault-mcp --vault /absolute/path/to/vault
```

The vault path must be absolute. Neuro Vault MCP expects Smart Connections data in:

```text
<vault>/.smart-env/multi/*.ajson
```

On first run, the query embedding model is downloaded automatically. That initial model download may add noticeable startup latency.

## Requirements

- Node.js 20 or newer
- An Obsidian vault on the local machine
- Smart Connections data present in `<vault>/.smart-env/multi/*.ajson`

## Installation

Install globally:

```bash
npm install -g neuro-vault-mcp
```

Or run it on demand with `npx`:

```bash
npx -y neuro-vault-mcp --vault /absolute/path/to/vault
```

## MCP Configuration Example

Most MCP hosts just need the binary and vault argument:

```json
{
  "command": "neuro-vault-mcp",
  "args": ["--vault", "/absolute/path/to/vault"]
}
```

If your host uses a more explicit JSON configuration, the same launch command applies:

```json
{
  "mcpServers": {
    "neuro-vault": {
      "command": "neuro-vault-mcp",
      "args": ["--vault", "/absolute/path/to/vault"]
    }
  }
}
```

## CLI Usage

After installing globally, launch the server directly from your shell:

```bash
neuro-vault-mcp --vault /absolute/path/to/vault
```

The process speaks MCP over stdio, so it is intended to be started by a compatible client or wrapper process rather than visited in a browser.

## Available Tools

### `search_notes`

Search the loaded corpus by semantic similarity.

Parameters:

- `query` `string` required
- `limit` `number` optional, default `10`, must be a positive integer
- `threshold` `number` optional, default `0.5`, must be between `0` and `1`

### `get_similar_notes`

Find notes similar to a vault-relative note path.

Parameters:

- `note_path` `string` required, vault-relative and POSIX-style
- `limit` `number` optional, default `10`, must be a positive integer
- `threshold` `number` optional, default `0.5`, must be between `0` and `1`

### `find_duplicates`

Find note pairs with high embedding similarity.

Parameters:

- `threshold` `number` optional, default `0.9`, must be between `0` and `1`

### `get_stats`

Report corpus and embedding statistics.

Parameters:

- none

## Tool Output

All search-style tools return note paths relative to the vault, similarity scores, and the note blocks preserved from Smart Connections data. `get_stats` returns the loaded corpus size, block count, embedding dimension, and model key.

## Development Commands

```bash
npm run build
npm run lint
npm run format
npm run format:write
npm run test
```

## Limitations for v1

- Requires Smart Connections `.ajson` files already present in the vault
- Uses in-memory search only, with no persistent index
- Starts over stdio only, not HTTP or SSE
- Loads the embedding model at startup, so the first run can be slow
- Expects a local vault path and does not support remote vaults
