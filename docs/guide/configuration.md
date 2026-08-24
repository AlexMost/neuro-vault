# Configuration

## CLI arguments

| Argument         | Required | Default    | Description                                                                                                                                                             |
| ---------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vault`        | yes      | —          | Absolute path to an Obsidian vault directory. Repeat the flag to register additional vaults. The MCP-side alias is always the directory basename; there is no override. |
| `--semantic`     | no       | `true`     | Enable semantic search module (`--no-semantic` to skip)                                                                                                                 |
| `--help`         | no       | —          | Show help                                                                                                                                                               |
| `--version`      | no       | —          | Print the installed version and exit                                                                                                                                    |

The vault's directory basename is the MCP-side alias used by the `vault` parameter on multi-vault tool calls. If a tool call fails with `VAULT_NOT_FOUND`, the `vault` value passed does not match any registered `--vault name:path` alias — check the flags the server was started with.

## AGENTS.md / CLAUDE.md snippet

Add this to your `AGENTS.md` or `CLAUDE.md` to help the AI assistant use the vault effectively:

```markdown
## Vault search

Use vault-aware tools when vault context matters.
Do not guess about note contents when the vault can be searched.
Route by what you already know: an exact anchor (a path, today's daily note, a tag, a
frontmatter field) → vault operations (`read_notes`, `query_notes`, `create_note`,
`edit_note`, `read_daily`); fuzzy recall or a conceptual question → semantic search
(`search_notes`, `get_similar_notes`).
Call `get_vault_overview` once to orient yourself, and follow the `conventions` it
returns when reading, writing, or organising notes.
```

Spell the routing rule out rather than pointing at the server's MCP `instructions`. Clients truncate that string (Claude Code cuts it at 2048 characters) and sub-agents may receive none of it, so a project file that only says "follow the server instructions" can end up pointing at nothing. Tool descriptions and tool responses always arrive — which is why the snippet routes through `get_vault_overview` for the vault's own conventions.

## Vault conventions for external agents

An optional `<vault>/.neuro-vault/for-external-agents.md` carries your rules for how *your* vault is organised — closed sets of frontmatter `type` values, folders that are off-limits for writes, how you scope notes to a project. The server picks it up with no configuration.

It reaches the agent through the `conventions` field of every `get_vault_overview` response (and the `vault://overview` resource, `vault://<vault-name>/overview` when several vaults are registered), read fresh on each call — edit the file and the next call sees it, with no server restart. The same text is also placed at the front of the MCP `instructions`, best-effort, for clients that render them — but that copy is composed once at server startup, so only the `get_vault_overview` channel reflects later edits.

Keep it under **8,000 characters**: beyond that the field carries a trimmed slice and sets `conventions_truncated: true`. The call still succeeds; the tail is simply gone. In multi-vault mode each vault carries its own file.

Full behaviour: [`docs/architecture/vault-conventions.md`](../architecture/vault-conventions.md).

## Excluding paths from discovery

By default, every note the server discovers — for the lexical leg of `search_notes`, `query_notes`, tag/property listings, `get_vault_overview` counts, backlinks, and note-name resolution — excludes dot-directories (`.obsidian/`, `.git/`, `.neuro-vault/`, …), `Templates/`, and every entry named in the vault root's `.gitignore`, if one exists. Two surfaces are unaffected: `read_notes` with an explicit path (a direct read, not a discovery call), and semantic matches, which come from the Smart Connections corpus and follow Smart Connections' own exclusion settings until the server's own embedding indexer lands.

To exclude additional paths, add an optional `<vault>/.neuro-vault/config.json`:

```json
{ "exclusions": ["Archive/**", "Scratch/**"] }
```

Each entry is a glob, anchored at the vault root, added on top of the built-in defaults — this list can only exclude more, not re-include something the defaults already exclude. Matching is case-sensitive, even on macOS: `Archive/**` does not exclude `archive/`. The file is read once, when the server starts; edit it and restart the server to pick up the change.

A missing file means the built-in defaults only, silently. Everything else that can go wrong falls back to the defaults and logs a warning to **stderr** while the server keeps running: an unreadable file, invalid JSON, a top-level value that isn't a JSON object (a bare `["Archive/**"]` array is the easy mistake), or an `"exclusions"` value that isn't a string array. Individual entries that are empty or start with `!` are dropped with a warning naming them — `!` cannot re-include a path here, and an empty entry would otherwise match nothing useful.

**Don't use an allowlist-style `.gitignore`.** Negation lines are not honoured, so a `.gitignore` that starts with `*` and re-includes with `!Notes/` excludes your entire vault from discovery — searches return nothing. The server warns on stderr when it sees such a line, but the fix is to list what you want *out* rather than what you want in.

Full behaviour, including the exact `.gitignore` subset that's honoured: [`docs/architecture/vault-scope.md`](../architecture/vault-scope.md).

## Troubleshooting

**"Smart Connections directory does not exist"** — make sure the Smart Connections plugin has run and generated embeddings. Open Obsidian, let Smart Connections finish indexing, then restart the MCP server.

**First startup is slow** — the embedding model (~40 MB) is downloading. Subsequent starts use the cached model.

**Search returns nothing** — first try the call again *without* `threshold` at all: an omitted threshold gets the effort default (0.5 quick / 0.35 deep) plus an automatic one-shot retry at 0.3 if that finds nothing (flagged as `semantic_fallback: true` in `query_stats` for array queries). Passing `threshold` explicitly disables that retry — an explicit value is a hard filter with no rescue, so `threshold: 0.3` returns zero rather than falling back further. Also confirm the Smart Connections corpus path is configured and that `search_notes` returns results for a broad query like `search_notes({ query: "note" })`.

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
