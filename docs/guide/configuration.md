# Configuration

## CLI arguments

| Argument         | Required | Default    | Description                                                                                                                                                             |
| ---------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vault`        | yes      | —          | Absolute path to an Obsidian vault directory. Repeat the flag to register additional vaults. The MCP-side alias is always the directory basename; there is no override. |
| `--semantic`     | no       | `true`     | Enable semantic search module (`--no-semantic` to skip; `search_notes` then runs lexical-only)                                                                                                                 |
| `--model`        | no       | `harrier-270m` | Embedding model profile, one per process: `harrier-270m` (default, multilingual, ≈ 344 MB), `granite-97m` (lite multilingual, ≈ 98 MB, fastest to index) or `harrier-0.6b` (highest quality, ≈ 706 MB, slowest to index). An unknown key fails and lists the valid ones. Applies to `index` too — each model keeps its own corpus per vault, so another value never rebuilds anything; give `index` the server's value to pre-warm the corpus the server serves. Which to pick, how to switch, and the benchmarks: [Embedding models](./embedding-models.md). |
| `--shared`       | no       | `true`     | Use the shared background daemon, which holds one copy of the model, and of each vault's index and its watcher, for every session on the machine and is started on demand. `--no-shared` runs both in this process instead. Applies to `index` too, which embeds through the daemon. See [Installation → What runs in the background](./installation.md#what-runs-in-the-background). |
| `--prune`        | no       | `false`    | `index` only. After indexing each vault, delete every other model's corpus under it (and a leftover single-corpus layout), reporting what was removed. Refuses (that vault fails) if the selected model's corpus is missing at prune time, so a concurrent prune by another model never leaves the vault empty; a wait for the lock prints the same waiting line as indexing. See [Embedding models](./embedding-models.md#switching-models). |
| `--help`         | no       | —          | Show help                                                                                                                                                               |
| `--version`      | no       | —          | Print the installed version and exit                                                                                                                                    |

`neuro-vault-mcp daemon [status|stop] [--idle-timeout <min>]` runs, lists or stops the shared-services daemon, the background process that holds the embedding model:

- `daemon status` lists every known daemon of every installed build: version, pid, connected sessions, the models it has loaded, and whether it is alive. Under a live daemon it adds one line per vault it holds (its sessions, or how long it has been idle) and one per model of that vault (indexing progress or note count, and the last reconcile). It removes the records of daemons that are gone.
- `daemon stop` asks every running daemon to exit. A session that is still open starts a new one on its next search.
- `daemon` alone runs one in the foreground, which you rarely need: the server and `index` start one on demand. `--idle-timeout` sets how long it stays after its last session disconnects (default 30 minutes, `0` = never); the same timeout frees a vault, or one model's index of it, that no session has used for that long.

The `--model` profiles:

- `harrier-270m` — the default; multilingual, balanced quality and cost, ≈ 344 MB.
- `granite-97m` — lite multilingual, ≈ 98 MB; for small hosts or a fast first index.
- `harrier-0.6b` — highest quality, ≈ 706 MB, slowest to index.

**Similarity thresholds are per profile.** The built-in defaults — `search_notes` (`threshold` and its fallback retry, `expansion_floor`), `get_similar_notes` (`threshold`) and `find_duplicates` (`threshold`) — are the active profile's own calibrated values, because every model scores on its own cosine scale (`harrier-270m`'s `quick` is 0.20, `granite-97m`'s is 0.71). The `search_notes` tool description quotes the numbers in force. The table of all defaults is in [Finding Notes → Tuning threshold](./finding-notes.md#tuning-threshold-semantic-leg). An explicit `threshold` or `expansion_floor` is on the active model's scale and does not carry over when you switch `--model`.

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

> Verifying a change to the server's `instructions` needs a **fresh session**: in Claude Code, `/mcp reconnect` reconnects the server but does not rebuild the session's system prompt, so the old string stays in place and the change reads as a false negative.

## Vault conventions for external agents

An optional `<vault>/.neuro-vault/for-external-agents.md` carries your rules for how *your* vault is organised — closed sets of frontmatter `type` values, folders that are off-limits for writes, how you scope notes to a project. The server picks it up with no configuration.

It reaches the agent through the `conventions` field of every `get_vault_overview` response (and the `vault://overview` resource, `vault://<vault-name>/overview` when several vaults are registered), read fresh on each call — edit the file and the next call sees it, with no server restart. That is the only channel that carries the text: the MCP `instructions` string carries a pointer telling the agent to make the call, never a copy of your file ([ADR-0012](../adr/0012-conventions-leave-the-instructions-channel.md)).

Keep it under **8,000 characters**: beyond that the field carries a trimmed slice and sets `conventions_truncated: true`. The call still succeeds; the tail is simply gone. In multi-vault mode each vault carries its own file.

Full behaviour: [`docs/architecture/vault-conventions.md`](../architecture/vault-conventions.md).

## Excluding paths from discovery

By default, every note the server discovers — for the lexical leg of `search_notes`, `query_notes`, tag/property listings, `get_vault_overview` counts, backlinks, and note-name resolution — excludes dot-directories (`.obsidian/`, `.git/`, `.neuro-vault/`, …), `Templates/`, and every entry named in the vault root's `.gitignore`, if one exists. One surface is unaffected: `read_notes` with an explicit path is a direct read, not a discovery call. Semantic matches are governed by the same rules — the server's own corpus is built from this same scoped scan, so an excluded note is never embedded either.

To exclude additional paths, add an optional `<vault>/.neuro-vault/config.json`:

```json
{ "exclusions": ["Archive/**", "Scratch/**"] }
```

Each entry is a glob, anchored at the vault root, added on top of the built-in defaults — this list can only exclude more, not re-include something the defaults already exclude. An entry that names a folder works without the trailing `/**`: `"Archive"` and `"**/drafts"` exclude the folder and everything under it, like a `.gitignore` entry. An entry ending in a wildcard (`*.excalidraw.md`, `Archive/*`) matches exactly what the glob says. Matching is case-sensitive, even on macOS: `Archive/**` does not exclude `archive/`. The file is read once, when the server starts; edit it and restart the server to pick up the change.

A missing file means the built-in defaults only, silently. Everything else that can go wrong falls back to the defaults and logs a warning to **stderr** while the server keeps running: an unreadable file, invalid JSON, a top-level value that isn't a JSON object (a bare `["Archive/**"]` array is the easy mistake), or an `"exclusions"` value that isn't a string array. Individual entries that are empty or start with `!` are dropped with a warning naming them — `!` cannot re-include a path here, and an empty entry would otherwise match nothing useful.

**Don't use an allowlist-style `.gitignore`.** Negation lines are not honoured, so a `.gitignore` that starts with `*` and re-includes with `!Notes/` excludes your entire vault from discovery — searches return nothing. The server warns on stderr when it sees such a line, but the fix is to list what you want *out* rather than what you want in.

Full behaviour, including the exact `.gitignore` subset that's honoured: [`docs/architecture/vault-scope.md`](../architecture/vault-scope.md).

## Disabling semantic search per vault

Add `"semantic": false` to that same `<vault>/.neuro-vault/config.json` to opt one vault out of embeddings entirely:

```json
{ "semantic": false }
```

With it set, the vault's semantic backend is built but reports `state: "disabled"` — `search_notes` still runs its lexical leg and reports `semantic_status: { state: "disabled" }` for that vault (fan-out is unaffected; no vault is skipped), and the embeddings-only tools (`get_similar_notes`, `find_duplicates`) return `SEMANTIC_DISABLED` when targeting it. No corpus and no watcher run for that vault — the embedding model itself may still load (in the shared daemon, or in the process with `--no-shared`) if another registered vault has semantic search enabled, since one model serves every vault. A session reads the key once, at startup, when it builds the vault's backend; the shared daemon re-reads it, with the vault's scope, every time a session attaches the vault.

The global `--no-semantic` flag outranks this: it turns the semantic module off for every registered vault, and a vault's own `"semantic": true` cannot turn it back on. With it, `search_notes` stays available and answers from its lexical leg alone, reporting `semantic_status: { state: "disabled" }` on every response, while `get_similar_notes` and `find_duplicates` are not registered. Use `--no-semantic` when you never want embeddings server-wide; use the per-vault key when only one vault (of several) should opt out.

## Troubleshooting

**Semantic results are missing or thin right after startup** — a vault with no embedding index yet indexes in the background; check `semantic_status` on the `search_notes` response (`state: "indexing"` means it is still building, `indexed`/`total` show progress). Either wait for it to finish, or warm it ahead of time with `neuro-vault-mcp index --vault <path> --model <key>` (the same `--model` the server runs with; omit it for the default; see [Installation → First-run behavior](./installation.md#first-run-behavior)).

**First startup is slow** — the embedding model is downloading (`granite-97m` ≈ 98 MB, `harrier-270m` ≈ 344 MB, `harrier-0.6b` ≈ 706 MB) into `~/.cache/neuro-vault/models` (or `$XDG_CACHE_HOME/neuro-vault/models`). Subsequent starts use the cached model. The first index of a vault then takes minutes, longer with the larger models ([cost per model](./embedding-models.md#the-profiles)).

**`shared daemon unavailable (…); running in-process for this session`** on stderr — the session could not reach or start the shared daemon, so it loaded the model and runs its vaults' indexes itself, exactly as with `--no-shared`. Everything still works; the session just holds its own copy of the model and of each vault's index. The reason is in the parentheses, and the daemon's own output is in the `daemon.log` the line names: its start line, each model it loaded and how long that took, and each load or embedding failure with its message. Common causes:

- running from source (`npm run dev`, which never starts a daemon);
- `/tmp/neuro-vault-<uid>` belonging to another user, or being a symlink: delete it if it is stale;
- a read-only cache directory.

A daemon that answers but fails to load the model is not a fallback; that error is reported like a local load failure and retried on the next call.

**Two models' worth of memory after an upgrade** — a session started before the upgrade keeps using the old version's daemon, and new sessions start one for the new version. The old daemon exits 30 minutes after its last old session closes, so the cure is to **restart the sessions started before the upgrade** (restart your MCP client). `neuro-vault-mcp daemon status` shows both daemons. Don't reach for `daemon stop` to end the old one while those sessions are still open: an old session cannot start the old version's daemon again (its files were replaced), so it loads the model and its vaults' indexes in its own process, says so once on stderr (`the CLI script … changed since this session started`), and keeps working that way until it is restarted. The same happens if the old daemon crashes.

**Indexing uses a lot of memory** — indexing and the model's memory now sit in the shared daemon (`neuro-vault-mcp daemon`), not in each session, unless you run with `--no-shared`. With `harrier-270m`, about 1.3–1.6 GB peak while indexing a vault of roughly a thousand notes (two separate runs); larger vaults will need more, and the bake-off's measuring script, which also held the whole corpus and token statistics in memory, peaked near 1.9 GB, so treat that as an upper bound. On a small host, run with `--model granite-97m` (about 1.2 GB on the same vault, and the quickest first index).

**The log says it is discarding the corpus and re-indexing** (the daemon's `daemon.log` by default, the server's stderr with `--no-shared`) — that model's corpus in the vault was built with a different identity (a new pinned revision of the model, or an older extraction version) than the one now active, so only that corpus is rebuilt from scratch in the background; `search_notes` answers from its lexical leg meanwhile. Another `--model` does not cause this: each model has its own corpus directory. See [Switching models](./embedding-models.md#switching-models).

**The log says a corpus lock is still held by another process** (same place) — passes over one vault take turns across processes on `<vault>/.neuro-vault/corpus/reconcile.lock`, so a server or `index` run waits while another one indexes the vault; a server keeps serving what it has meanwhile. The line (`… reconcile.lock is still held by pid <n> — serving the current corpus and retrying later`) appears only after a 30-minute wait and means the server will try again later. If that process is not a neuro-vault server or `index` run — it crashed, or its pid was reused, or it ran on another machine — delete the lock file.

**Search returns nothing** — first try the call again *without* `threshold` at all: an omitted threshold gets the active model's effort default (`quick` / `deep`) plus an automatic one-shot retry at its `fallback` floor if that finds nothing (flagged as `semantic_fallback: true` in `query_stats` for array queries). Passing `threshold` explicitly disables that retry — an explicit value is a hard filter with no rescue, so a `threshold` above every score returns zero rather than falling back. A `threshold` copied from a setup that used another model is a common cause: it is on the other model's scale. Also check `semantic_status` — `"disabled"` or `"unavailable"` means the semantic leg isn't running for that vault at all — and confirm `search_notes` returns results for a broad query like `search_notes({ query: "note" })`.

## Limitations

- In-memory search only — no persistent database; the on-disk corpus under `.neuro-vault/corpus/` is the persistence, loaded into memory once per vault by the shared daemon (by each session with `--no-shared`) and kept current by that vault's watcher.
- stdio transport only — not HTTP or SSE.
- Local vault path only — no remote vaults.
- One embedding model per process, chosen with `--model` — every registered vault uses it. Switching models indexes each vault once for the new model, beside the corpus of the previous one (`index --prune` removes the others). The model's weights are loaded once per machine per installed version (in the shared daemon) and shared by every session on that model; with `--no-shared`, once per process.
- The embedding model is warmed up in the background after the server connects (skipped when every vault has semantic search disabled), and a failed load is retried on the next query. The first run also downloads it, so it can be slow.
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
