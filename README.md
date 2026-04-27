# Neuro Vault MCP

**Semantic vault search and direct vault operations for your Obsidian vault — right inside your AI assistant.**

[![npm version](https://img.shields.io/npm/v/neuro-vault-mcp)](https://www.npmjs.com/package/neuro-vault-mcp)
[![Node.js](https://img.shields.io/node/v/neuro-vault-mcp)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> "What did I write about that idea last month?" — and now your assistant can actually answer.

---

## ✨ Why Neuro Vault?

- 🧠 **Semantic search over your existing vault** — reuses [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) embeddings already in your vault. No re-indexing, no API keys, no extra infrastructure.
- 🎯 **Mode-aware retrieval** — `quick` for direct lookups, `deep` for exploratory questions with block-level results and semantic expansion of related notes.
- ✍️ **Direct vault operations** — read, create, append, and prepend notes; manage frontmatter properties and inspect tags (including daily notes) straight from your AI assistant via the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli).
- ⚡ **Zero infrastructure** — local stdio MCP server, in-memory index, no database, no background processes, no watchers.
- 🔌 **Drop-in for any MCP client** — Claude Code, Cursor, Windsurf — configuration is a single JSON block.

---

## 🏗 How it works

```mermaid
flowchart LR
    You([You]) --> AI[AI assistant]
    AI <-->|MCP| NV[Neuro Vault]
    NV <--> Vault[(Obsidian vault)]
```

You ask, the assistant calls Neuro Vault, Neuro Vault reads your vault — semantic search uses embeddings already in `.smart-env/`, vault operations go through the `obsidian` CLI. No database, no background processes.

For module wiring and internal data flow, see [docs/architecture/module-structure.md](./docs/architecture/module-structure.md).

---

## ⚡ Quickstart

```bash
npm install -g neuro-vault-mcp
```

Add to your MCP client config (here: Claude Code's `~/.claude/settings.json`):

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

Then ask your assistant:

> "What did I write about building AI agents?"

On first run the embedding model downloads automatically (~40 MB). Subsequent starts are fast.

For other clients (Cursor / Windsurf / npx), see [docs/guide/installation.md](./docs/guide/installation.md).

---

## 📚 Documentation

User guide lives in [`docs/guide/`](./docs/guide/README.md):

- [Installation](./docs/guide/installation.md)
- [Semantic Search](./docs/guide/semantic-search.md) — `search_notes`, `get_similar_notes`, `find_duplicates`, `get_stats`
- [Vault Operations](./docs/guide/vault-operations.md) — note CRUD, daily notes, properties, tags
- [Routing Between Tools](./docs/guide/routing.md)
- [Configuration](./docs/guide/configuration.md) — CLI args, troubleshooting, limitations, development

Architecture / internals: [`docs/architecture/`](./docs/architecture/).

---

## 📄 License

ISC — see [LICENSE](LICENSE).

Changelog: [Releases](https://github.com/AlexMost/neuro-vault/releases)
