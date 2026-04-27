# Remove `get_tag` Tool — Design

**Status:** approved, 2026-04-27
**Supersedes (in part):** `docs/superpowers/specs/2026-04-26-properties-and-tags-tools-design.md` — that spec introduced `get_tag` as one of six new tools; we are now removing it.

## Goal

Remove the `get_tag` MCP tool from the operations module. Functionality is now subsumed by `query_notes` with `{ filter: { tags: '<name>' } }`, which is strictly more general and reads from disk without needing Obsidian.

## Why

- `get_tag(tag)` returns `{ name, count, files }`. The same answer falls out of `query_notes({ filter: { tags: tag } })` as `{ count, results: [{ path, frontmatter }] }`. `files = results.map(r => r.path)`.
- `query_notes` reads through `FsVaultReader` (direct disk), while `get_tag` shells out to the `obsidian` CLI's `tag` subcommand. Removing `get_tag` shrinks the surface that requires Obsidian to be running.
- Two tools that overlap teach the LLM client the wrong lesson: that "list notes by tag" needs special-case routing. A single composable query is simpler to reason about.

## Scope

In:

- Remove tool registration `get_tag` from `src/modules/operations/tools.ts`.
- Remove handler `getTag` from `src/modules/operations/tool-handlers.ts`.
- Remove `getTag` from `OperationsToolHandlers`, drop `GetTagToolInput`.
- Remove `getTag` from `VaultProvider` interface; drop `GetTagInput` / `GetTagResult`.
- Remove `getTag` impl from `ObsidianCLIProvider`; drop the `tag not found` stderr → `TAG_NOT_FOUND` mapping (no other CLI command produces it).
- Remove `TAG_NOT_FOUND` from `OperationsErrorCode`.
- Remove all `get_tag` / `getTag` references from current-state docs (`docs/architecture/*`, `docs/guide/*`, `README.md`, `AGENTS.md`, `src/server.ts` instructions).
- Remove `get_tag` test blocks (`tools.test.ts`, `tool-handlers.test.ts`, `obsidian-cli-provider.test.ts`, `server-modules.test.ts`); update tool-count assertions (12 → 11, 16 → 15).
- Update server instructions in `src/server.ts` to point clients at `query_notes({ filter: { tags } })` for tag-driven questions.

Out:

- Rewriting `list_tags` / `list_properties` on top of `FsVaultReader` (still go through obsidian-cli). Tracked separately.
- Migration of `read_property` to disk-based reads. Separate.
- Any client-side compatibility shim. Major version bump; no shim.

## Migration

Clients calling `get_tag({ tag: 'X' })` switch to:

```json
{ "filter": { "tags": "X" } }
```

`include_files: false` (suppress file list for popular tags) becomes a non-issue: `query_notes` returns `{ count, results }` where `results` already has a `limit` (default 100) and per-item shape `{ path, frontmatter }`. Set `limit: 1` to get just the count without the full list. The leading `#` strip that `get_tag` did is the LLM's responsibility (`tag.replace(/^#/, '')`).

## Definition of done

- `npm test` green; tool count assertions updated.
- `npm run lint` and `npx tsc --noEmit` clean.
- No occurrence of `get_tag` / `getTag` in `src/**`, `test/**`, or current-state docs (`docs/architecture/**`, `docs/guide/**`, `README.md`, `AGENTS.md`).
- Old specs (`docs/superpowers/specs/2026-04-26-*.md`) are NOT edited — they remain the historical record of when `get_tag` was introduced.
- Major version bump on next release (`3.0.0`); changelog notes the breaking change and migration.
