# Installation

## Requirements

- Node.js 20.19+, 22.12+, or 23+ (the floor `yargs` 18 declares)
- A vault — a directory of Markdown notes. An Obsidian vault is one, but Obsidian itself is not required: no plugin, no running app.

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

- The embedding model is downloaded on first run into `~/.cache/neuro-vault/models` (or `$XDG_CACHE_HOME/neuro-vault/models` when `XDG_CACHE_HOME` is an absolute path) and shared across upgrades. The default, `harrier-270m`, is ≈ 344 MB; `granite-97m` (`--model granite-97m`, a lite multilingual model) is ≈ 98 MB and `harrier-0.6b` ≈ 706 MB. Subsequent starts are fast. Pick the model with `--model`; see [Configuration](./configuration.md#cli-arguments) and [Embedding models](./embedding-models.md). The similarity thresholds are calibrated per model, so no tuning is needed when you switch.
- **Plan for memory and time on the first index.** With the default `harrier-270m`, indexing a vault of about a thousand notes took minutes (≈ 9 on the measured vault) and peaked at about 1.3–1.6 GB of RAM (two separate runs); the bake-off report extrapolates from its measured throughput that a vault of about 56,000 vectors would take roughly 55–100 minutes. `granite-97m` is the light option — about 3.5 minutes on the same thousand-note vault, 1.2 GB peak, and an estimated 24 minutes on that 56,000-vector vault ([bake-off report](../research/2026-10-embedding-model-bakeoff.md)). Later runs only re-embed the notes that changed. Measurements and the full table: [Embedding models](./embedding-models.md#the-profiles).
- **Upgrading from a release whose default was a different model indexes every vault once with the new default**, in the background, the first time the new version starts (each model keeps its own corpus, so the old model's corpus is not reused and is not discarded: it is moved into its own directory under `.neuro-vault/corpus/`, and `index --prune` removes it). `search_notes` answers from its lexical leg meanwhile. To take that cost ahead of time — before a demo, or on a large vault — run `neuro-vault-mcp index --vault <path>` once after upgrading (see below). If you pass an explicit `threshold` or `expansion_floor` that you tuned on the old model (say `0.5`), re-tune or drop it: it is on a different scale under `harrier-270m`, whose query-to-note similarities sit mostly below about 0.44 on the measured vault (95th percentile 0.440).
- On a CPU-only Linux x64 machine, set `ONNXRUNTIME_NODE_INSTALL=skip` when installing (`ONNXRUNTIME_NODE_INSTALL=skip npm install -g neuro-vault-mcp`) to skip the CUDA provider download that onnxruntime's install script otherwise starts on that platform. According to onnxruntime-node's install script, other platforms download nothing extra.
- A vault with no embedding index yet starts indexing in the background as soon as the server boots — it does not block startup. While that first pass runs, `search_notes` still answers immediately from its lexical leg alone and reports `semantic_status: { state: "indexing", indexed, total }`; the embeddings-only tools (`get_similar_notes`, `find_duplicates`) return `SEMANTIC_INDEX_BUILDING` for that vault until the pass finishes. No restart is needed — the vault is promoted to `ready` live.
- If the `--vault` directory itself does not exist, the server exits immediately with an error before starting.

### Optional: warm the index first

To skip that degraded first window — useful before a demo, or for a large vault — build the index ahead of time and exit:

```bash
neuro-vault-mcp index --vault /absolute/path/to/your/vault
```

Pass the same `--model` the server runs with (`harrier-270m` is the default and needs no flag; if the server's `args` carry `--model granite-97m`, add `--model granite-97m` here too): that warms the corpus the server will serve. A different value is not harmful — each model keeps its own corpus in the vault — but it builds a second corpus the server never reads. The `SEMANTIC_INDEX_NOT_FOUND` hint prints `neuro-vault-mcp index --vault <path>` without `--model` — add yours if you run a non-default model.

`index` embeds through the same shared daemon as the server. A run next to an open session therefore loads no second copy of the model. `--no-shared` makes it load its own.

Repeat `--vault` to warm several vaults in one run. It prints per-vault progress and a summary (`indexed`, `embedded`, `reused`, `renamed`, `deleted`, `failed`), and exits non-zero if any note failed to embed. Re-running it later is cheap: an unchanged vault reconciles in well under a second, since only notes that changed since the last pass are re-embedded. If another neuro-vault process (a server, or another `index`) is reconciling the same vault, `index` waits its turn and says so on stderr (`waiting for another neuro-vault process (pid <n>) to finish with <vault>…`).

Add `--prune` to delete the corpora other models have left in the vault once the indexing has succeeded: `neuro-vault-mcp index --vault /absolute/path/to/your/vault --prune`. It prints `pruned <vault>: removed <names>` (or `nothing to remove`), and does nothing, with a `not pruning <vault>: …` line on stderr, if no note was indexed. It also refuses, failing that vault, if the selected model's corpus is missing when it runs, so a concurrent prune by another model can never leave the vault empty; a prune that waits for another process prints the same waiting line as indexing. See [Embedding models](./embedding-models.md#switching-models).

## What runs in the background

When a session starts with semantic search enabled and shared, it starts one background process, `neuro-vault-mcp daemon`, unless one is already running, and every later session on the machine shares it. It does so for any registered vault, including one that sets `"semantic": false`, because `search_notes` reads every vault's lexical cache from that process too; it starts none under `--no-semantic` or `--no-shared`. The daemon is new in 17.1; attaching `"semantic": false` vaults to it for the text-search cache is new in 17.2. The model then sits in memory once, in that process, instead of once per session, and so does each vault's index, with the watcher that keeps it fresh, and each vault's text-search cache: sessions on one vault share one copy (`neuro-vault-mcp daemon status` shows it as a `lexical` line under each vault). A vault with `"semantic": false` gets the cache only: no index, no watcher, and the model loads only if another vault uses it. On a measured laptop, three sessions took about 1.3 GB in total with the daemon, against 2.4–2.6 GB as three separate processes.

- **It belongs to you and to this installed version.** It runs as your user and listens on a local socket, `/tmp/neuro-vault-<uid>/<key>.sock`, in a directory only you can open. It opens no network port. After an upgrade, new sessions start a new daemon, and the old one stays only while sessions of the old version are open. Restart those sessions to move them to the new version.
- **It leaves on its own.** It exits 30 minutes after its last session disconnects. A vault's index stays loaded for the same 30 minutes after the last session using it leaves, so a restarted session finds it warm.
- **Its files** are under `~/.cache/neuro-vault/daemons/<key>/` (or `$XDG_CACHE_HOME/neuro-vault/daemons/<key>/`): `daemon.log` (its output), `daemon.json` (pid, version, socket) and `daemon.lock`.
- **Inspect or end it** with `neuro-vault-mcp daemon status` and `neuro-vault-mcp daemon stop`.
- **Opt out** with `--no-shared` in the server's `args` (and on `index`): the session then loads the model itself and indexes and watches its own vaults, and keeps their text-search caches itself. If the daemon cannot be started, the session does the same on its own and says so once on stderr. Windows is untested: there the daemon listens on a named pipe, and any failure falls back the same way.
