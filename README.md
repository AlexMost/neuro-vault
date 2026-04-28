# Neuro Vault MCP

**Semantic vault search and direct vault operations for your Obsidian vault — right inside your AI assistant.**

[![npm version](https://img.shields.io/npm/v/neuro-vault-mcp)](https://www.npmjs.com/package/neuro-vault-mcp)
[![Node.js](https://img.shields.io/node/v/neuro-vault-mcp)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

> "What did I write about that idea last month?" — and now your assistant can actually answer.

---

## ✨ Why Neuro Vault?

- 🧠 **Semantic search that already knows your vault** — reuses [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) embeddings. No re-indexing, no API keys, no extra infrastructure.
- 🎯 **Quick or deep, your call** — fast direct lookups for "find that note", or exploratory mode with related-note expansion when the question is fuzzy.
- 🧭 **A real navigation toolkit for your agent** — instead of grepping files and opening notes one by one, your assistant walks the vault like a database: filter by tags and properties, batch-read metadata, discover the structure, jump to semantic neighbours.
- 🔎 **Ask structured questions in plain language** — _"active projects tagged #ai"_, _"todo tasks with a deadline this week"_, _"meeting notes from `Work/` newest first"_ — one call, ranked answer, no chains of reads.
- ✍️ **Read and write through Obsidian itself** — create, append, edit notes, manage frontmatter and daily notes via the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli), so Smart Connections, sync, and other plugins stay in the loop.
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

## 🧭 Your vault, but queryable

A plain-text vault is great for humans and rough on agents. Without the right tools, an assistant ends up listing folders, opening dozens of notes, and grepping inside each one just to answer a simple question.

Neuro Vault gives your assistant a way to **ask the vault directly** — by tag, by frontmatter property, by folder, by similarity. Things like:

> _"What are my active projects tagged #ai with a deadline this quarter?"_
> _"Show meeting notes from `Work/` from the last two weeks."_
> _"Find notes similar to this one I'm reading."_

One question, one answer. Your assistant stops being a file browser and starts being an actual second brain.

→ See [docs/guide/vault-operations.md](./docs/guide/vault-operations.md#query_notes) for the full query language and examples.

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
- [Vault Operations](./docs/guide/vault-operations.md) — note CRUD, daily notes, properties, tags, structured queries (`query_notes`)
- [Routing Between Tools](./docs/guide/routing.md)
- [Configuration](./docs/guide/configuration.md) — CLI args, troubleshooting, limitations, **migration to 2.0**, development

Architecture / internals: [`docs/architecture/`](./docs/architecture/).

---

## 📄 License

ISC — see [LICENSE](LICENSE).

Changelog: [Releases](https://github.com/AlexMost/neuro-vault/releases)
