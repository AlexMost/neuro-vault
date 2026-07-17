# Configuration

## CLI arguments

| Argument         | Required | Default    | Description                                                                                                                                                             |
| ---------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vault`        | yes      | —          | Absolute path to an Obsidian vault directory. Repeat the flag to register additional vaults. The MCP-side alias is always the directory basename; there is no override. |
| `--semantic`     | no       | `true`     | Enable semantic search module (`--no-semantic` to skip)                                                                                                                 |
| `--help`         | no       | —          | Show help                                                                                                                                                               |

The vault's directory basename is the MCP-side alias used by the `vault` parameter on multi-vault tool calls. If a tool call fails with `VAULT_NOT_FOUND`, the `vault` value passed does not match any registered `--vault name:path` alias — check the flags the server was started with.

## AGENTS.md / CLAUDE.md snippet

Add this to your `AGENTS.md` or `CLAUDE.md` to help the AI assistant use the vault effectively:

```markdown
## Vault search

Use vault-aware tools when vault context matters.
Do not guess about note contents when the vault can be searched.
Follow the Neuro Vault MCP server instructions for routing between semantic search (`search_notes`, `get_similar_notes`) and operations (`read_notes`, `create_note`, `edit_note`, `read_daily`).
```

## Troubleshooting

**"Smart Connections directory does not exist"** — make sure the Smart Connections plugin has run and generated embeddings. Open Obsidian, let Smart Connections finish indexing, then restart the MCP server.

**First startup is slow** — the embedding model (~40 MB) is downloading. Subsequent starts use the cached model.

**Search returns nothing** — try lowering the threshold: `threshold: 0.3`. Also confirm the Smart Connections corpus path is configured and that `search_notes` returns results for a broad query like `search_notes({ query: "note", threshold: 0.3 })`.

## Limitations

- Requires Smart Connections `.ajson` files already present in the vault.
- In-memory search only — no persistent index, no background re-indexing.
- stdio transport only — not HTTP or SSE.
- Local vault path only — no remote vaults.
- Embedding model loaded at startup; first run can be slow.
- All vault operations (`read_notes`, `create_note`, `edit_note`, properties, tags, daily notes) read and write the vault directory directly on disk. No Obsidian installation or running instance is required — the server runs fully headless.

## Lenient input coercion

Some MCP clients serialize every tool-call argument as a string. To keep these calls working, the server coerces stringified primitives at the top level of each tool's input schema before validation:

- `number` fields accept numeric strings: `limit: "5"` → `5`, `threshold: "0.35"` → `0.35`.
- `boolean` fields accept `"true"` / `"false"`: `include_content: "true"` → `true`.
- `object` / `record` fields accept stringified JSON: `filter: '{"tags":"x"}'` → `{ tags: "x" }`.

Coercion only fires when the schema unambiguously expects the target primitive — fields typed as `string | number` (e.g. `set_property.value`) are left as strings. Coercion is one level deep; the contents of a parsed `filter` object are not further transformed.

When validation still fails, the server returns a structured `INVALID_PARAMS` error with a `details.issues` array (`[{ path, message, expected }]`) — not a raw zod dump.

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
