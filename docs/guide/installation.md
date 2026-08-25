# Installation

## Requirements

- Node.js 20+
- An Obsidian vault (a directory of Markdown notes) — no plugin required

Vault operations (`create_note`, `read_daily`, `edit_note`, properties, tags) read and write the vault directory directly on disk — no Obsidian installation or running instance is required. The server runs headless. The embedding index the semantic leg searches is one the server builds itself from your notes; see [First-run behavior](#first-run-behavior) below.

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

**No dedicated scope yet?** Skip the snippet for now. The agent will probe the vault structure with `get_vault_overview` (folders, tags, properties in one call — plus any conventions you have written for external agents) and fall back to `search_notes` for fuzzy recall. Add the snippet above once you settle on a scoping scheme.

**Working inside the vault itself?** The snippet is for _external_ projects connecting to the vault. When the agent operates directly inside the vault directory (vault dev, vault maintenance, plugin work), it has filesystem access plus the MCP tools and does not need a project scope — the whole vault is in scope by definition.

## Try it

Ask your assistant:

> "What did I write about building AI agents?"
>
> "Find my notes on productivity systems"
>
> "What are all my ideas related to embeddings?"

## First-run behavior

- The embedding model (`TaylorAI/bge-micro-v2`, ~40 MB) is downloaded on first run and cached by `@xenova/transformers`. Subsequent starts are fast.
- A vault with no embedding index yet starts indexing in the background as soon as the server boots — it does not block startup. While that first pass runs, `search_notes` still answers immediately from its lexical leg alone and reports `semantic_status: { state: "indexing", indexed, total }`; the embeddings-only tools (`get_similar_notes`, `find_duplicates`) return `SEMANTIC_INDEX_BUILDING` for that vault until the pass finishes. No restart is needed — the vault is promoted to `ready` live.
- If the `--vault` directory itself does not exist, the server exits immediately with an error before starting.

### Optional: warm the index first

To skip that degraded first window — useful before a demo, or for a large vault — build the index ahead of time and exit:

```bash
neuro-vault-mcp index --vault /absolute/path/to/your/vault
```

Repeat `--vault` to warm several vaults in one run. It prints per-vault progress and a summary (`indexed`, `embedded`, `reused`, `renamed`, `deleted`, `failed`), and exits non-zero if any note failed to embed. Re-running it later is cheap: an unchanged vault reconciles in well under a second, since only notes that changed since the last pass are re-embedded.
