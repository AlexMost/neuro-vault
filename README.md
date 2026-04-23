# Neuro Vault MCP

**Semantic search over your Obsidian vault — right inside your AI assistant.**

[![npm version](https://img.shields.io/npm/v/neuro-vault-mcp)](https://www.npmjs.com/package/neuro-vault-mcp)
[![Node.js](https://img.shields.io/node/v/neuro-vault-mcp)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> "What did I write about that idea last month?"

Neuro Vault MCP connects your Obsidian vault to any MCP-compatible AI assistant. It reuses the embeddings already computed by [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) — no re-indexing, no extra infrastructure, no API keys.

---

## How It Works

```
Your question
     │
     ▼
 AI assistant
     │ rewrites to keyword queries + picks mode
     ▼
 search_notes (MCP tool)
     │
     ├─ vector search over Smart Connections embeddings
     ├─ block-level search (all modes)
     └─ expansion via similar notes (deep mode)
     │
     ▼
 Ranked results with note paths, similarity scores, section headings
```

The server loads `.smart-env/multi/*.ajson` into memory at startup and keeps it there. No background processes, no watchers, no database.

---

## Requirements

- Node.js 20+
- Obsidian vault with [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) plugin (embeddings must be generated)
- Smart Connections data at `<vault>/.smart-env/multi/*.ajson`

---

## Quick Start

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

## AGENTS.md / CLAUDE.md Snippet

Add this to your `AGENTS.md` or `CLAUDE.md` to help the AI assistant use the vault effectively:

```markdown
## Vault search

Use the `search_notes` MCP tool to search my Obsidian vault before answering questions about my notes, projects, or ideas.

Search protocol:

1. Choose mode: `quick` for specific questions, `deep` for broad topics
2. Rewrite the query: extract 2-4 keywords, remove filler words
3. Call search_notes once per concept — use separate calls for synonyms and UA↔EN translations

Skip vault search for: general programming questions, translations, tasks with no personal knowledge component.
```

---

## Configuration

### CLI Arguments

| Argument  | Required | Description                                   |
| --------- | -------- | --------------------------------------------- |
| `--vault` | yes      | Absolute path to the Obsidian vault directory |
| `--help`  | no       | Show help                                     |

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

---

## License

ISC — see [LICENSE](LICENSE).

Changelog: [Releases](https://github.com/AlexMost/neuro-vault/releases)
