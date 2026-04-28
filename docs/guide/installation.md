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

## Connect the vault as a second brain to a project

The MCP server tells your agent that this vault is your personal knowledge base, but it cannot know which slice of it belongs to the project you are currently working on — the same vault is typically connected to many projects, and people scope notes differently (a tag, a folder, a frontmatter property, or a combination).

Tell the agent how to find project notes in your project's own instructions (e.g. `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, or equivalent). Use the form that matches how you actually organise things — examples:

```md
## Personal knowledge base (neuro-vault)

Notes for this project live in the Obsidian vault. To find them, run
`query_notes` with the filter that matches my organisation:

- by tag: { filter: { tags: '<your-tag>' } }
- by folder: { path_prefix: '<your-folder>/' }
- by property: { filter: { 'frontmatter.project': '<your-project>' } }

(Pick one or combine — whatever describes where the notes actually are.)

Before brainstorming new directions, drafting retrospectives, or
answering "why did we decide X", consult the vault first — the answer
often lives there and nowhere else. Skip this for trivial or mechanical
tasks where the project's own artifacts are the source of truth.
```

The agent will use that filter as the entry point whenever project context beyond the working directory might matter.

**No dedicated scope yet?** Skip the snippet for now. The agent will probe the vault structure (`list_tags`, `list_properties`, exploratory `query_notes`) and fall back to `search_notes` for fuzzy recall. Add the snippet above once you settle on a scoping scheme.

**Working inside the vault itself?** The snippet is for _external_ projects connecting to the vault. When the agent operates directly inside the vault directory (vault dev, vault maintenance, plugin work), it has filesystem access plus the MCP tools and does not need a project scope — the whole vault is in scope by definition.

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
