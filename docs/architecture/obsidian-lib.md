# `src/lib/obsidian/` — Obsidian vault library

## What this is

A library of utilities and abstractions that understand the Obsidian vault format — and nothing else. No MCP-server coupling, no tool-handler error mapping, no module dependency-injection wiring.

## Why it exists

Before this layer, vault-format knowledge was scattered across `src/modules/operations/` and `src/modules/semantic/`: the YAML frontmatter splitter, the `VaultReader` interface, the Smart Connections corpus parser, the query engine, and five differently-named copies of "validate this vault-relative POSIX path". Co-locating it makes the boundary explicit between _what a vault is_ and _what we expose over MCP_, and it gives future format-aware utilities (wikilink parsing, backlink indexing, dataview-style queries) one obvious home.

## What lives here

- **`paths.ts`** — vault-relative path validation (`normalizeVaultPath`), naive backslash-to-slash conversion (`toPosixSlashes`), subtree-prefix normalization (`normalizeScanPrefix`). Throws plain `Error`. Tool-handler wrappers in `src/modules/operations/tool-helpers.ts` and `src/modules/semantic/tool-helpers.ts` translate to `ToolHandlerError` for the MCP layer.
- **`frontmatter.ts`** — `splitFrontmatter(raw)` separates a YAML-fenced frontmatter block from the body. Tolerant of malformed YAML (returns `frontmatter: null` and the raw content).
- **`in-place-edit.ts`** — `splitRawFrontmatter(raw)` returns the raw frontmatter prefix (fences included) alongside the body, so a write can rewrite the body while preserving frontmatter byte-for-byte. `applyReplace(body, find, replacement)` does exact-string replacement, returning `NOT_FOUND` or `AMBIGUOUS_MATCH` with the matching line numbers rather than guessing which occurrence was meant. See [`./disk-write-path.md`](./disk-write-path.md).
- **`inline-tags.ts`** — `extractInlineTags(body)` collects deduped inline `#tags` from a markdown body, without the leading `#`. Walks the mdast tree so code fences and inline code are excluded structurally, and follows Obsidian's tag grammar (`[A-Za-z0-9_/-]`, at least one non-numeric character).
- **`vault-provider.ts`** — `VaultProvider` interface plus the type vocabulary (`NoteIdentifier`, `PropertyType`, `PropertyValue`, etc.) used by both the abstraction and its consumers. See [`./vault-provider.md`](./vault-provider.md).
- **`vault-reader.ts`** — `VaultReader` interface and `FsVaultReader` (filesystem-backed implementation). Reads notes, splits frontmatter, supports subtree scanning. Reports stale-path conditions via `ScanPathNotFoundError`. See [`./vault-reader.md`](./vault-reader.md).
- **`vault-writer.ts`** — `VaultWriter` interface and `FsVaultWriter`, its filesystem-backed implementation, covering `edit_note`'s two modes (`ReplaceInNoteInput` for find/replace, `ReplaceFullBodyInput` for a whole-body rewrite). Composes `in-place-edit.ts` so frontmatter survives every write. See [`./disk-write-path.md`](./disk-write-path.md).
- **`vault-conventions.ts`** — the optional owner-authored `.neuro-vault/for-external-agents.md`: `CONVENTIONS_PATH`, the best-effort `readVaultConventions(vaultPath)` (missing / empty / unreadable all collapse to `null`), and `capConventions` with `CONVENTIONS_CHAR_CAP`. Shared by the `get_vault_overview` payload and by `buildServerInstructions`. See [`./vault-conventions.md`](./vault-conventions.md).
- **`note-path.ts`** — `normalizeNotePath(raw)`, the single-note path normalizer (auto-appends `.md`) shared by every tool that identifies one note. See [`./note-path-resolution.md`](./note-path-resolution.md).
- **`daily-notes-config.ts`** — `readDailyNotesConfig(vaultRoot)` reads and validates `.obsidian/daily-notes.json`, throwing `DAILY_NOTES_NOT_CONFIGURED` when it is absent, malformed, or has no `folder`.
- **`daily-note-path.ts`** — `formatDailyDate(format, date)`, a minimal moment.js-compatible renderer for the Daily Notes basename format.
- **`smart-connections-types.ts`** — `SmartBlock` / `SmartSource` interfaces describing the parsed shape of a Smart Connections AJSON record.
- **`smart-connections-loader.ts`** — parses the Smart Connections plugin's `.ajson` corpus into a `Map<vaultPath, SmartSource>`. The semantic search module consumes this at startup. See [`./smart-connections-corpus.md`](./smart-connections-corpus.md).
- **`smart-connections-corpus-index.ts`** — `createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey })` wraps that loader in a lazily-refreshing cache. `snapshot()` returns `{ sources, basenameIndex }`, reloading only when the `.ajson` directory's signature (max mtime + file count) changes, so a re-embedded vault is picked up without a server restart.
- **`wikilink.ts`** — `parseWikilinks(text)` extracts `[[...]]` occurrences from arbitrary text (matches embeds `![[...]]` too). `normalizeWikilinkTarget(raw)` strips `#heading` and `|alias` suffixes, returning the bare target.
- **`frontmatter-links.ts`** — `extractWikilinksFromFrontmatter(fm)` recursively walks a parsed frontmatter object and collects `[[...]]` targets from every string value. Non-string leaves are ignored.
- **`link-resolver.ts`** — `buildBasenameIndex(paths)` returns a `BasenameIndex` whose `resolve(target)` maps a wikilink target to a vault-relative path. Targets containing `/` are looked up as exact paths (with optional `.md` suffix); bare basenames fall back to a basename → paths index. On basename collision, the lexicographically smallest path wins (deterministic).
- **`note-links.ts`** — `getNoteLinks({ notePath, readNoteContent, basenameIndex })` reads one note and returns the set of vault-relative paths it forward-links to, from `[[wikilinks]]` in both the body and frontmatter values. The note's own path and unresolved targets are dropped; read errors propagate unmapped.
- **`wikilink-graph.ts`** — `WikilinkGraphIndex`, the vault-wide in-memory adjacency (`{ incoming, outgoing }`) over `[[wikilinks]]` and `![[embeds]]`, in body and frontmatter alike. Built lazily on first query and rebuilt by `ensureFresh()` once a TTL (default 3 minutes) has elapsed. Unresolved outgoing targets are kept verbatim. See [`./wikilink-graph.md`](./wikilink-graph.md).
- **`top-by-backlinks.ts`** — `topByBacklinks({ paths, graph, limit })` ranks notes by inbound wikilink count, returning `{ path, title, backlink_count }`.
- **`vault-overview.ts`** — `computeVaultOverview(deps)` builds the orientation snapshot served by both the `get_vault_overview` tool and the `vault://overview` resource: top-level folders with counts, top tags, frontmatter properties, total note count, and the top notes by backlinks. Its caps are exported (`TOP_TAGS_LIMIT`, `TOP_PROPERTIES_LIMIT`, `TOP_BACKLINKS_LIMIT`). All I/O is injected — the function touches no `fs` directly.
- **`query/`** — the metadata query engine (`query_notes` tool's backend). MongoDB-style filter via `sift`, frontmatter + tags + path-prefix, deterministic sort, batched reads. Exports `runQueryNotes` plus the supporting types and a strict filter whitelist. See [`./query.md`](./query.md).
- **`lexical/`** — the lexical leg of `search_notes`. `LexicalIndex` (mtime-cached per-note parse), `parseNote` for mdast block extraction, `normalizeText` / `tokenizeQuery`, and `rankNotes` for tiered title/heading/body scoring. See [`./lexical-search.md`](./lexical-search.md).

## What does _not_ live here

- MCP tool handlers (`src/modules/operations/tools/*`, `src/modules/semantic/tools/*`) — they bind input schemas and translate errors.
- Module wiring (`src/modules/operations/index.ts`, `src/modules/semantic/index.ts`) — they assemble dependency-injection graphs.
- `fs-vault-provider.ts` (`src/modules/operations/fs-vault-provider.ts`) — the `VaultProvider` implementation itself lives with the operations module, not here; this library owns only the interface and the vault-format primitives the implementation composes (`frontmatter.ts`, `in-place-edit.ts`, `inline-tags.ts`, `note-path.ts`, `daily-notes-config.ts`, `daily-note-path.ts`).
- ML / search-engine code (`src/modules/semantic/embedding-service.ts`, `search-engine.ts`, `retrieval-policy.ts`).
- `OperationsErrorCode` and other MCP-tool error vocabularies.

## How it is consumed

- `src/lib/vault-registry.ts` builds one entry per configured vault from the factories in `buildDefaultVaultEntryDeps` (`src/server.ts`), constructing `FsVaultReader`, `FsVaultWriter`, `WikilinkGraphIndex`, the per-vault conventions reader (`readVaultConventions` bound to that vault's path) and the Smart Connections corpus index per vault. Both modules then read those entries off the registry rather than constructing anything themselves.
- `src/modules/operations/tool-helpers.ts` and `src/modules/semantic/tool-helpers.ts` wrap `normalizeVaultPath` with `ToolHandlerError` translation under their existing public names (`normalizePath`, `normalizeNotePath`) so call sites in tool handlers don't need to know about the lib.
- The Smart Connections corpus is no longer loaded directly by the semantic module: `smart-connections-corpus-index.ts` owns the loader call and the `BasenameIndex`, and the registry exposes it per vault as `entry.corpus`. `snapshot()` yields both, and `get_similar_notes` uses them (with `note-links.ts`) to extract and resolve `[[wikilinks]]` from the query note as forward-link signals.
- `src/modules/operations/tools/query-notes.ts` calls `runQueryNotes` from `query/`.
