# `src/lib/obsidian/` — Obsidian vault library

## What this is

A library of utilities and abstractions that understand the Obsidian vault format — and nothing else. No MCP-server coupling, no tool-handler error mapping, no module dependency-injection wiring.

## Why it exists

Before this layer, vault-format knowledge was scattered across `src/modules/operations/` and `src/modules/semantic/`: the YAML frontmatter splitter, the `VaultReader` interface, the Smart Connections corpus parser, the query engine, and five differently-named copies of "validate this vault-relative POSIX path". Co-locating it makes the boundary explicit between _what a vault is_ and _what we expose over MCP_, and it gives future format-aware utilities (wikilink parsing, backlink indexing, dataview-style queries) one obvious home.

## What lives here

- **`paths.ts`** — vault-relative path validation (`normalizeVaultPath`), naive backslash-to-slash conversion (`toPosixSlashes`), subtree-prefix normalization (`normalizeScanPrefix`). Throws plain `Error`. Tool-handler wrappers in `src/modules/operations/tool-helpers.ts` and `src/modules/semantic/tool-helpers.ts` translate to `ToolHandlerError` for the MCP layer.
- **`frontmatter.ts`** — `splitFrontmatter(raw)` separates a YAML-fenced frontmatter block from the body. Tolerant of malformed YAML (returns `frontmatter: null` and the raw content).
- **`vault-provider.ts`** — `VaultProvider` interface plus the type vocabulary (`NoteIdentifier`, `PropertyType`, `PropertyValue`, etc.) used by both the abstraction and its consumers. See [`./vault-provider.md`](./vault-provider.md).
- **`vault-reader.ts`** — `VaultReader` interface and `FsVaultReader` (filesystem-backed implementation). Reads notes, splits frontmatter, supports subtree scanning. Reports stale-path conditions via `ScanPathNotFoundError`.
- **`note-path.ts`** — `normalizeNotePath(raw)`, the single-note path normalizer (auto-appends `.md`) shared by every tool that identifies one note. See [`./note-path-resolution.md`](./note-path-resolution.md).
- **`daily-notes-config.ts`** — `readDailyNotesConfig(vaultRoot)` reads and validates `.obsidian/daily-notes.json`, throwing `DAILY_NOTES_NOT_CONFIGURED` when it is absent, malformed, or has no `folder`.
- **`daily-note-path.ts`** — `formatDailyDate(format, date)`, a minimal moment.js-compatible renderer for the Daily Notes basename format.
- **`smart-connections-types.ts`** — `SmartBlock` / `SmartSource` interfaces describing the parsed shape of a Smart Connections AJSON record.
- **`smart-connections-loader.ts`** — parses the Smart Connections plugin's `.ajson` corpus into a `Map<vaultPath, SmartSource>`. The semantic search module consumes this at startup.
- **`wikilink.ts`** — `parseWikilinks(text)` extracts `[[...]]` occurrences from arbitrary text (matches embeds `![[...]]` too). `normalizeWikilinkTarget(raw)` strips `#heading` and `|alias` suffixes, returning the bare target.
- **`frontmatter-links.ts`** — `extractWikilinksFromFrontmatter(fm)` recursively walks a parsed frontmatter object and collects `[[...]]` targets from every string value. Non-string leaves are ignored.
- **`link-resolver.ts`** — `buildBasenameIndex(paths)` returns a `BasenameIndex` whose `resolve(target)` maps a wikilink target to a vault-relative path. Targets containing `/` are looked up as exact paths (with optional `.md` suffix); bare basenames fall back to a basename → paths index. On basename collision, the lexicographically smallest path wins (deterministic).
- **`query/`** — the metadata query engine (`query_notes` tool's backend). MongoDB-style filter via `sift`, frontmatter + tags + path-prefix, deterministic sort, batched reads. Exports `runQueryNotes` plus the supporting types and a strict filter whitelist.

## What does _not_ live here

- MCP tool handlers (`src/modules/operations/tools/*`, `src/modules/semantic/tools/*`) — they bind input schemas and translate errors.
- Module wiring (`src/modules/operations/index.ts`, `src/modules/semantic/index.ts`) — they assemble dependency-injection graphs.
- `fs-vault-provider.ts` (`src/modules/operations/fs-vault-provider.ts`) — the `VaultProvider` implementation itself lives with the operations module, not here; this library owns only the interface and the vault-format primitives the implementation composes (`frontmatter.ts`, `note-path.ts`, `link-resolver.ts`, `daily-notes-config.ts`, `daily-note-path.ts`).
- ML / search-engine code (`src/modules/semantic/embedding-service.ts`, `search-engine.ts`, `retrieval-policy.ts`).
- `OperationsErrorCode` and other MCP-tool error vocabularies.

## How it is consumed

- `src/modules/operations/index.ts` constructs `FsVaultReader` and wires it into the operations tools.
- `src/modules/operations/tool-helpers.ts` and `src/modules/semantic/tool-helpers.ts` wrap `normalizeVaultPath` with `ToolHandlerError` translation under their existing public names (`normalizePath`, `normalizeNotePath`) so call sites in tool handlers don't need to know about the lib.
- `src/modules/semantic/index.ts` calls `loadSmartConnectionsCorpus` at startup, builds a `BasenameIndex` from the resulting `sources` keys, and passes both (alongside a `readNoteContent` helper closing over `vaultPath`) to its tool handlers. `get_similar_notes` uses these to extract and resolve `[[wikilinks]]` from the query note as forward-link signals.
- `src/modules/operations/tools/query-notes.ts` calls `runQueryNotes` from `query/`.
