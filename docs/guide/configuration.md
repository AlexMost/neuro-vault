# Configuration

## CLI arguments

| Argument         | Required | Default    | Description                                             |
| ---------------- | -------- | ---------- | ------------------------------------------------------- |
| `--vault`        | yes      | —          | Absolute path to the Obsidian vault directory           |
| `--semantic`     | no       | `true`     | Enable semantic search module (`--no-semantic` to skip) |
| `--operations`   | no       | `true`     | Enable vault operations module (`--no-operations`)      |
| `--obsidian-cli` | no       | `obsidian` | Path to the `obsidian` CLI binary (override only)       |
| `--help`         | no       | —          | Show help                                               |

## AGENTS.md / CLAUDE.md snippet

Add this to your `AGENTS.md` or `CLAUDE.md` to help the AI assistant use the vault effectively:

```markdown
## Vault search

Use vault-aware tools when vault context matters.
Do not guess about note contents when the vault can be searched.
Follow the Neuro Vault MCP server instructions for routing between semantic search (`search_notes`, `get_similar_notes`) and operations (`read_notes`, `create_note`, `edit_note`, `read_daily`, `append_daily`).
```

## Troubleshooting

**"Smart Connections directory does not exist"** — make sure the Smart Connections plugin has run and generated embeddings. Open Obsidian, let Smart Connections finish indexing, then restart the MCP server.

**First startup is slow** — the embedding model (~40 MB) is downloading. Subsequent starts use the cached model.

**Search returns nothing** — try lowering the threshold: `threshold: 0.3`. Also check that `get_stats` shows a non-zero `totalNotes`.

**Vault operations fail with `CLI_NOT_FOUND` / `CLI_UNAVAILABLE`** — the `obsidian` CLI isn't on `PATH`, or Obsidian isn't running. Install the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli), or pass `--obsidian-cli /absolute/path/to/obsidian`. Disable the module with `--no-operations` if you only want semantic search.

## Limitations

- Requires Smart Connections `.ajson` files already present in the vault.
- In-memory search only — no persistent index, no background re-indexing.
- stdio transport only — not HTTP or SSE.
- Local vault path only — no remote vaults.
- Embedding model loaded at startup; first run can be slow.
- Write operations (`create_note`, `edit_note`, properties, tags, daily notes) require the Obsidian CLI and a running Obsidian instance — they fail gracefully per call when unavailable. `read_notes` reads directly from disk and is not affected by this limitation.

## Development

```bash
npm run build        # compile TypeScript to dist/
npm run test         # run tests with vitest
npm run lint         # ESLint
npm run format       # check formatting with Prettier
npm run format:write # fix formatting
```

## Migration to 2.0

`read_note` has been removed from the MCP surface. Use `read_notes` for the single-note case as well: `{ "paths": ["Path/To/Note.md"] }`. Reads now go directly to the vault directory on disk and do not require Obsidian to be running.
