# Neuro Vault MCP

> 🧠💾 **Plug your knowledge in like a USB drive.** Your Obsidian vault, available in every AI conversation — search it, query it, write to it. Same vault in Claude Code, Cursor, Windsurf — no copy-paste, no context-switching, no re-indexing.

https://github.com/user-attachments/assets/0ba43373-3f97-4dc6-ab91-4f30bdafd0bf

[![npm version](https://img.shields.io/npm/v/neuro-vault-mcp)](https://www.npmjs.com/package/neuro-vault-mcp)
[![Node.js](https://img.shields.io/node/v/neuro-vault-mcp)](https://nodejs.org)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Your second brain stops being a folder you open between contexts and becomes a first-class participant in every project. Ask, recall, decide, write back — all without leaving the conversation.

> _"What did I write about that idea last month?"_ — and now your assistant can actually answer.

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

## 🧰 Two superpowers, one server

Most "vault MCP" servers give you one or the other. Neuro Vault gives you both, and lets your assistant pick the right one per question:

|                  | 🔭 **Semantic recall**                                                    | 🛠 **Vault operations**                                                        |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **What it does** | Finds notes by meaning, not keywords. Surfaces neighbours and duplicates. | Reads, writes, edits notes; manages frontmatter, tags, daily notes.            |
| **Best for**     | _"What did I think about X?"_, fuzzy recall, exploratory research.        | Structured queries, capturing decisions, updating tasks, batch reads.          |
| **Powered by**   | Smart Connections embeddings (already in your vault).                     | The official Obsidian CLI — Smart Connections, sync, plugins all stay in sync. |

The two work together: semantic search finds the right region of the vault, vault operations let the assistant actually _do something_ with what it found.

---

## ✨ What it looks like in practice

**Before:** _"Could you check my notes about that LangGraph experiment?"_
→ Assistant lists `Notes/`, opens 12 files, greps for "LangGraph", gives up halfway, you paste the relevant note manually.

**After:** _"Could you check my notes about that LangGraph experiment?"_
→ One semantic search, top-3 ranked notes back, follow-up question already grounded in your own writing.

A few more questions Neuro Vault makes one-shot:

> _"What are my active projects tagged #ai with a deadline this quarter?"_
> _"Show meeting notes from `Work/` from the last two weeks, newest first."_
> _"Find notes similar to this one I'm reading."_
> _"Append today's decision to the daily note."_
> _"What did past-me write about retrieval policy before I started building it?"_

One question, one answer. Your assistant stops being a file browser and starts being an actual second brain.

→ See [docs/guide/vault-operations.md](./docs/guide/vault-operations.md#query_notes) for the full query language and examples.

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
- [Vault Operations](./docs/guide/vault-operations.md) — note CRUD, daily notes, properties, tags, structured queries (`query_notes`)
- [Routing Between Tools](./docs/guide/routing.md)
- [Configuration](./docs/guide/configuration.md) — CLI args, troubleshooting, limitations, **migration to 2.0**, development

Architecture / internals: [`docs/architecture/`](./docs/architecture/).

---

## 📄 License

ISC — see [LICENSE](LICENSE).

Changelog: [Releases](https://github.com/AlexMost/neuro-vault/releases)
