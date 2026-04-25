# Neuro Vault MCP

**Semantic vault search and expansion for your Obsidian vault — right inside your AI assistant.**

[![npm version](https://img.shields.io/npm/v/neuro-vault-mcp)](https://www.npmjs.com/package/neuro-vault-mcp)
[![Node.js](https://img.shields.io/node/v/neuro-vault-mcp)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> "What did I write about that idea last month?"

Neuro Vault MCP provides semantic search over your Obsidian vault and semantic expansion for related notes. Agents can combine it with structural tools for exact note, path, date, tag, property, and link lookups when those tools are available. It reuses the embeddings already computed by [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) — no re-indexing, no extra infrastructure, no API keys.

---

## How It Works

```
Your question
     │
     ▼
 AI assistant
     │ routes by intent
     ▼
     ├──────────────► Structural tools
     │               (exact file, title, path, daily note, tag, property, wikilink, backlink, link traversal)
     │
     └──────────────► search_notes
                     (semantic retrieval)
                             │
                             ▼
                     get_similar_notes
                     (semantic expansion)
```

The server loads `.smart-env/multi/*.ajson` into memory at startup and keeps it there. No background processes, no watchers, no database.

## Search Routing

Tool routing and retrieval policy are related, but not the same thing.

- Use structural tools first for exact file, title, path, daily note, tag, property, wikilink, backlink, and link traversal requests.
- Use `search_notes` for fuzzy topic, concept, and semantic retrieval.
- Use `get_similar_notes` after you already have a relevant note and want semantic expansion.
- Treat the routing guidance as behavior, not enforcement; the server does not hard-block other tool choices.
- Use semantic retrieval to find likely notes, then switch to structural tools when you need exact anchors.

---

## Requirements

- Node.js 20+
- Obsidian vault with [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) plugin (embeddings must be generated)
- Smart Connections data at `<vault>/.smart-env/multi/*.ajson`

### Operations module (optional)

- The [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) installed and on `PATH` (or pass `--obsidian-cli`).
- Obsidian running with the URI handler available.
- Disable with `--no-operations` if you only want semantic search.

---

## Quick Start

<details>
     <summary>Install instructions...</summary>

**1. Install**

```bash
npm install -g neuro-vault-mcp
```

**2. Configure your MCP client**

For Claude Code (`~/.claude/settings.json` or `.claude/settings.json` in your project):

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

For Cursor or Windsurf (`.cursor/mcp.json` / `.windsurf/mcp.json`):

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

Or run without installing using `npx`:

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

</details>

**3. Try it**

Ask your assistant:

> "What did I write about building AI agents?"

> "Find my notes on productivity systems"

> "What are all my ideas related to embeddings?"

On first run the embedding model downloads automatically (~40 MB). Subsequent starts are fast.

---

## Features

### Mode-Based Search

Every search picks a mode that controls retrieval depth:

| Mode    | Use when                          | Limit | Threshold | Expansion |
| ------- | --------------------------------- | ----- | --------- | --------- |
| `quick` | Specific question, need 1-2 notes | 3     | 0.50      | off       |
| `deep`  | Broad topic, need an overview     | 8     | 0.35      | on        |

The AI assistant picks the mode automatically based on your question. You can also pass it explicitly.

### Block-Level Results (Deep Mode)

In `deep` mode the server also searches by individual note sections (blocks), not just whole notes. This surfaces the exact paragraphs that are most relevant, not just the note they live in.

### Expansion (Deep Mode)

After finding top results, the server uses their embeddings to discover neighboring notes. This catches related notes that don't directly match your query but are semantically close to what you found.

### Automatic Fallback

When vector search returns nothing, the server retries with a lower similarity threshold (0.3). If still nothing — the AI assistant can search vault files using its own tools.

---

## Tools Reference

### `search_notes`

Search the vault by semantic similarity.

```typescript
search_notes({
  query: string,               // short keyword query (1-4 words)
  mode?: "quick" | "deep",    // default: "quick"
  threshold?: number,          // override mode default (0–1)
  expansion?: boolean,         // override mode default
  expansion_limit?: number,    // how many top results to expand (default: 3)
})
```

Returns `results` (ranked notes) and `blockResults` (ranked sections — scoped to matched notes in quick mode, all sources in deep mode).

**Tips for better results:**

- Use short keyword queries (1–4 words), not full sentences
- Call multiple times for synonyms and translations: `"embeddings"`, then `"векторний пошук"`, then `"vector search"`
- Lower the threshold to `0.3` if nothing comes back
- Use `deep` mode for exploratory questions

---

### `get_similar_notes`

Find notes similar to a given note path.

```typescript
get_similar_notes({
  note_path: string,  // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
  limit?: number,     // default: 10
  threshold?: number, // default: 0.5
})
```

Use this after `search_notes` finds a relevant note — it discovers related content without needing a text query.

---

### `find_duplicates`

Find note pairs with high embedding similarity.

```typescript
find_duplicates({
  threshold?: number, // default: 0.9
})
```

Useful for vault maintenance: identifies notes that cover the same topic and could be merged.

---

### `get_stats`

Report loaded corpus statistics.

Returns: `{ totalNotes, totalBlocks, embeddingDimension, modelKey }`

---

## Vault Operations

Direct, structural operations on the vault via the Obsidian CLI. Requires Obsidian to be running.

### `read_note`

Read a note's contents.

```typescript
read_note({
  name?: string,    // wikilink-style: "My Note"
  path?: string,    // vault-relative: "Folder/My Note.md"
})
```

Returns `{ path, content }`. Provide exactly one of `name` or `path`.

### `create_note`

Create a new note.

```typescript
create_note({
  name?: string,
  path?: string,
  content?: string,
  template?: string,
  overwrite?: boolean,
})
```

`overwrite: true` is destructive — the AI assistant will ask before passing it.

### `edit_note`

Add content to an existing note.

```typescript
edit_note({
  name?: string,
  path?: string,
  content: string,
  position: 'append' | 'prepend',
})
```

### `read_daily`

Read today's daily note. Returns `{ path, content }`.

### `append_daily`

Append content to today's daily note.

```typescript
append_daily({ content: string });
```

---

## AGENTS.md / CLAUDE.md Snippet

Add this to your `AGENTS.md` or `CLAUDE.md` to help the AI assistant use the vault effectively:

```markdown
## Vault search

Use vault-aware tools when vault context matters.
Do not guess about note contents when the vault can be searched.
Follow the Neuro Vault MCP server instructions for routing between semantic search (`search_notes`, `get_similar_notes`) and operations (`read_note`, `create_note`, `edit_note`, `read_daily`, `append_daily`).
```

---

## Configuration

### CLI Arguments

| Argument         | Required | Default    | Description                                             |
| ---------------- | -------- | ---------- | ------------------------------------------------------- |
| `--vault`        | yes      | —          | Absolute path to the Obsidian vault directory           |
| `--semantic`     | no       | `true`     | Enable semantic search module (`--no-semantic` to skip) |
| `--operations`   | no       | `true`     | Enable vault operations module (`--no-operations`)      |
| `--obsidian-cli` | no       | `obsidian` | Path to the `obsidian` CLI binary (override only)       |
| `--help`         | no       | —          | Show help                                               |

### Startup Behavior

- Smart Connections `.ajson` files are loaded into memory once at startup
- The embedding model (`TaylorAI/bge-micro-v2`) is downloaded on first run and cached by `@xenova/transformers`
- If the vault path is missing or Smart Connections data is absent, the server exits immediately with an error

### Troubleshooting

**"Smart Connections directory does not exist"** — make sure the Smart Connections plugin has run and generated embeddings. Open Obsidian, let Smart Connections finish indexing, then restart the MCP server.

**First startup is slow** — the embedding model (~40 MB) is downloading. Subsequent starts use the cached model.

**Search returns nothing** — try lowering the threshold: `threshold: 0.3`. Also check that `get_stats` shows a non-zero `totalNotes`.

---

## Development

```bash
npm run build       # compile TypeScript to dist/
npm run test        # run tests with vitest
npm run lint        # ESLint
npm run format      # check formatting with Prettier
npm run format:write  # fix formatting
```

---

## Limitations

- Requires Smart Connections `.ajson` files already present in the vault
- In-memory search only — no persistent index, no background re-indexing
- stdio transport only — not HTTP or SSE
- Local vault path only — no remote vaults
- Embedding model loaded at startup; first run can be slow
- Operations tools require the Obsidian CLI and a running Obsidian instance — they fail gracefully per call when unavailable.

---

## License

ISC — see [LICENSE](LICENSE).

Changelog: [Releases](https://github.com/AlexMost/neuro-vault/releases)
