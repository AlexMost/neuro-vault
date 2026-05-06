# `edit_note` & daily-note redesign — drop CLI-only write tools

> Supersedes `2026-05-06-edit-note-in-place-design.md`. The earlier spec added
> `replace` and `replace_full` alongside the existing `append`/`prepend`
> positions, and kept `append_daily` as a separate convenience tool. While
> implementing, the dual write-path under one tool name (CLI for
> append/prepend, direct-fs for replace/replace_full) and the redundancy of
> `append_daily` (composable from `read_daily` + `edit_note`) became visible.
> This spec collapses the surface accordingly.

## Goal

Reduce the vault-write API to one consistent write path (direct filesystem)
and remove convenience tools that the caller can compose from primitives.
The result is fewer tools, fewer modes, one set of semantics, and one
boundary between "this server" and "the obsidian-cli".

## Scope

Three breaking changes shipped together as one cohesive redesign (v5.0.0):

1. **`edit_note`**: drop `position: "append"` and `position: "prepend"`. The
   tool's `position` union becomes `"replace" | "replace_full"`. Frontmatter
   is still preserved by both modes.
2. **`append_daily`**: remove entirely. The composable replacement is
   `read_daily` → modify body locally → `edit_note({ position: "replace_full", path, content })`.
3. **Provider surface**: `VaultProvider.editNote` and
   `VaultProvider.appendDaily` are deleted along with their `ObsidianCLIProvider`
   implementations. The CLI provider's remaining write responsibilities are
   `createNote`, `setProperty`, `readProperty`, `removeProperty`.

`read_daily` stays — it is the only way to obtain today's daily-note path
(computed from the user's daily-notes plugin config) and its body in one
call. The daily-notes plugin auto-creates today's note on first access via
the CLI, which `read_daily` benefits from. If a caller wants to append
content and the note does not yet exist, the composition is
`create_note({ path, content })` (where the path is what `read_daily` would
have returned).

## Why

- **One write path, one promise.** Today the same `edit_note` tool sometimes
  routes through obsidian-cli (so Smart Connections / sync see the write
  immediately) and sometimes writes directly to disk (so they see it via
  the file watcher). Same tool, different side-effect timing. Dropping
  `append`/`prepend` removes this split entirely: `edit_note` is now a pure
  direct-fs tool, and the only operations still routed through obsidian-cli
  are creation and frontmatter mutations, which is a stable boundary.
- **Convenience tools are token-cheap to compose.** `append_daily` saves a
  read round-trip when the daily note already exists; the savings are
  modest, and the price is a tool that does the same thing as
  `edit_note(replace_full)` from a slightly different code path. Removing
  it reclaims one tool slot and one set of error mappings.
- **The append/prepend "atomicity" argument is theoretical.** MCP calls
  inside a session are serialised. The race only matters across MCP
  clients, which is not a workload this server has been shaped for.

## What stays

- `replace` semantics: exact-string find/replace inside the body, frontmatter
  untouched, `AMBIGUOUS_MATCH` on multi-match unless `replace_all: true`.
- `replace_full` semantics: overwrite the entire body, frontmatter preserved
  byte-for-byte; the note must already exist (`NOT_FOUND` otherwise — for
  new notes use `create_note`).
- `VaultWriter` interface and `FsVaultWriter` implementation.
- Pure transform module `src/lib/obsidian/in-place-edit.ts`.
- `BasenameIndex.resolveAll` for surfacing all candidate paths on name
  ambiguity.
- All tests for the above.

## What goes

- `edit_note` schema: the `append` and `prepend` discriminator branches.
- `appendOrPrepend` helper inside `src/modules/operations/tools/edit-note.ts`.
- `EditNoteAppendPrependInput` interface in
  `src/modules/operations/types.ts`. The `EditPositionToolInput` union
  becomes `"replace" | "replace_full"`. The `EditNoteToolInput` union loses
  one variant.
- `VaultProvider.editNote` method, `EditPosition`, `EditNoteInput` types,
  `ObsidianCLIProvider.editNote` implementation, and the CLI provider tests
  for it.
- `append_daily` tool (`src/modules/operations/tools/append-daily.ts`).
- `VaultProvider.appendDaily` method, `AppendDailyInput` type,
  `ObsidianCLIProvider.appendDaily` implementation, and the CLI provider
  tests for it.
- `AppendDailyToolInput` type in `src/modules/operations/types.ts`.
- All append-only fields from server prompt, README, guide.

## Composable replacement flows

| Old API                                | New flow                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `edit_note({ position: 'append' })`    | `read_notes([path])` → modify body → `edit_note({ position: 'replace_full' })`        |
| `edit_note({ position: 'prepend' })`   | Same — locally place content at the start of the body                                 |
| `append_daily({ content })`            | `read_daily()` → `edit_note({ position: 'replace_full', path, content: body + new })` |
| `append_daily` to a non-existent daily | `read_daily()` → `create_note({ path, content })`                                     |

The trade-off is one extra `read_daily` (or `read_notes`) call per write.
For the agentic workflow this is invisible — the assistant typically reads
before writing anyway.

## Migration note (for the changelog / README)

> v5.0.0 is a breaking change. `edit_note` no longer accepts `position:
"append"` or `position: "prepend"`; use the composable `read_notes` +
> `edit_note({ position: "replace_full" })` flow. The `append_daily` tool
> has been removed; use `read_daily` + `edit_note({ position:
"replace_full" })`. The new write surface is direct-filesystem and does
> not depend on Obsidian being running for `edit_note` operations (it is
> still required for `create_note`, `set_property`, `remove_property`).

## Definition of Done

- `edit_note` schema accepts only `replace` and `replace_full`. Calls with
  `append` or `prepend` now fail at schema validation with
  `INVALID_ARGUMENT`.
- `append_daily` tool is no longer registered; the MCP `tools/list` response
  no longer mentions it.
- `VaultProvider` interface lists no `editNote` or `appendDaily`. The
  `ObsidianCLIProvider` does not implement them.
- All tests for removed surface are dropped (not skipped). Tests for kept
  surface still pass. Test count drops by the removed cases — that is
  expected and intentional.
- README, server prompt, and `docs/guide/vault-operations.md` reflect the
  new surface. The `vault-operations` guide explicitly documents the
  composable daily-append flow.
- Release: minor version becomes major. Conventional Commit footer carries
  `BREAKING CHANGE:` so `commit-and-tag-version` bumps to v5.0.0.

## Connections

- Predecessor: `2026-05-06-edit-note-in-place-design.md`. The earlier
  design's Definition of Done items that survive (replace / replace_full /
  VaultWriter / pure transform module / docs for the kept positions) are
  shipped. The DoD items that are explicitly reversed by this spec are the
  retention of `append`/`prepend` and the existence of `append_daily`.
- Vault task note: `Tasks/Add in-place edit support to edit_note.md` —
  retained as the original motivation; the redesign goes further than
  that note proposed.
