# Installation

## Requirements

- Node.js 20+
- Obsidian vault with the [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) plugin (embeddings must be generated)
- Smart Connections data at `<vault>/.smart-env/multi/*.ajson`
- _For vault operations (optional):_ the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) on `PATH` and Obsidian running. Pass `--no-operations` to disable, or `--obsidian-cli /path` to point at a custom binary.

## Install

```bash
npm install -g neuro-vault-mcp
```

## Configure your MCP client

### Claude Code

`~/.claude/settings.json` (user-wide) or `.claude/settings.json` (per project):

```json
{
  "mcpServers": {
    "neuro-vault": {
      "command": "neuro-vault-mcp",
      "args": ["--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

### Cursor / Windsurf

`.cursor/mcp.json` or `.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "neuro-vault": {
      "command": "neuro-vault-mcp",
      "args": ["--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

### Without installing globally — use `npx`

```json
{
  "mcpServers": {
    "neuro-vault": {
      "command": "npx",
      "args": ["-y", "neuro-vault-mcp", "--vault", "/absolute/path/to/your/vault"]
    }
  }
}
```

## Try it

Ask your assistant:

> "What did I write about building AI agents?"
>
> "Find my notes on productivity systems"
>
> "What are all my ideas related to embeddings?"

## First-run behavior

- Smart Connections `.ajson` files are loaded into memory once at startup.
- The embedding model (`TaylorAI/bge-micro-v2`, ~40 MB) is downloaded on first run and cached by `@xenova/transformers`. Subsequent starts are fast.
- If the vault path is missing or Smart Connections data is absent, the server exits immediately with an error.
