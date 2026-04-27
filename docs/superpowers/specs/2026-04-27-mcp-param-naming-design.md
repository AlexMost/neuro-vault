# MCP Tool Parameter Naming Standardization

Status: design
Date: 2026-04-27
Supersedes: —

## Problem

Tool input schemas across `neuro-vault` MCP use inconsistent parameter names for the same concept. The most painful case: the field `name` carries three unrelated meanings depending on which tool you call.

| Tool group                                         | Field `name` means             |
| -------------------------------------------------- | ------------------------------ |
| `read_note`, `create_note`, `edit_note`            | wikilink-style note identifier |
| `set_property`, `read_property`, `remove_property` | frontmatter property key       |
| `get_tag`                                          | tag name                       |

To dodge that collision, property tools use `file` for the wikilink-style identifier — yet note tools call the same concept `name`. And the semantic tool `get_similar_notes` calls a vault-relative path `note_path`, while every other tool calls it `path`.

The practical effect is `INVALID_PARAMS` from the MCP server when the LLM (or human) reaches for the obvious-but-wrong field name. The cost grows with every new tool added.

## Goal

One concept → one parameter name across every tool the server exposes.

## Non-goals

- Renaming the tools themselves (`read_note`, `set_property`, etc. stay as they are).
- Changing parameter semantics — only the name on the wire.
- Backward compatibility. Hard break, single-user MCP. The next release is `2.0.0`.

## Decision

### Parameter dictionary

| Concept                        | Name    | Tools                                                                                                            |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Vault-relative POSIX path      | `path`  | `read_note`, `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`, `get_similar_notes` |
| Wikilink-style note identifier | `name`  | `read_note`, `create_note`, `edit_note`, `set_property`, `read_property`, `remove_property`                      |
| Frontmatter property key       | `key`   | `set_property`, `read_property`, `remove_property`                                                               |
| Tag name                       | `tag`   | `get_tag`                                                                                                        |
| Semantic query                 | `query` | `search_notes`                                                                                                   |

### Per-tool changes

| Tool                | Before                                 | After                                 |
| ------------------- | -------------------------------------- | ------------------------------------- |
| `set_property`      | `{ file?, path?, name, value, type? }` | `{ name?, path?, key, value, type? }` |
| `read_property`     | `{ file?, path?, name }`               | `{ name?, path?, key }`               |
| `remove_property`   | `{ file?, path?, name }`               | `{ name?, path?, key }`               |
| `get_tag`           | `{ name, include_files? }`             | `{ tag, include_files? }`             |
| `get_similar_notes` | `{ note_path, limit?, threshold? }`    | `{ path, limit?, threshold? }`        |

All other tools — `read_note`, `create_note`, `edit_note`, `read_daily`, `append_daily`, `list_properties`, `list_tags`, `search_notes`, `find_duplicates`, `get_stats` — already conform; no changes.

### Backward compatibility

None. `2.0.0` is a breaking release. Old field names are not accepted; passing `file`, `note_path`, or `name` in place of `key` results in a zod validation error mapped to `INVALID_PARAMS`.

## Implementation

### Files touched

- `src/modules/operations/tools.ts` — zod schemas and tool descriptions for property tools and `get_tag`.
- `src/modules/operations/types.ts` — input/output type aliases that reference the renamed fields.
- `src/modules/operations/tool-handlers.ts` — handler bodies read renamed fields. `resolvePropertyTarget` becomes redundant once it takes the same `(name, path)` shape as `resolveIdentifier`; collapse them.
- `src/modules/semantic/tools.ts` — `getSimilarNotesSchema` field rename.
- `src/modules/semantic/tool-handlers.ts` — handler reads `input.path`.
- `src/server.ts` — `SERVER_INSTRUCTIONS` examples and routing prose.
- `test/**` — vitest suites that exercise the renamed tools.
- `README.md` — user-facing examples.
- `AGENTS.md` — add a short "Parameter dictionary" section so future tools follow the rule by default.
- `docs/architecture/*.md` — only files that name params explicitly in prose.

Past specs in `docs/superpowers/specs/` are historical records and are NOT rewritten (per `AGENTS.md`).

### Schema-level mechanics

`resolveIdentifier` and `resolvePropertyTarget` differ only in error wording today. After the rename they take the same `(name, path)` shape with the same "exactly one of" rule, so they are merged into one helper. The merged helper's error messages use `name` / `path` (no more `file`).

`getTag` strips the leading `#` from `input.tag` exactly like it does today from `input.name`.

`getSimilarNotes` reads `input.path` and validates it the same way operations tools validate `path`.

### Error semantics

`INVALID_PARAMS` (zod) when an old-style field name is passed. The error message comes from zod and names the missing required field — that is sufficient signal for the caller to update the schema, given there is one human user.

## Tests

For each touched tool:

- One positive test using the new field name.
- Existing tests that referenced old field names are updated to use the new names. No backward-compat test is added — there is no backward-compat layer.

The merged `resolveIdentifier` helper gets a "exactly one of `name` or `path`" test if one does not already exist.

## Release

- Single Conventional Commit with `feat!:` prefix (or a `BREAKING CHANGE:` footer) so `commit-and-tag-version` produces `2.0.0`.
- `CHANGELOG.md` will list the renamed fields per tool under "BREAKING CHANGES".
- Release flow per `AGENTS.md`: PR → merge to `main` → `npm run release` on `main` → `git push --follow-tags`.

## Definition of Done

- Every tool's input schema uses the dictionary names above; no `file`, no `note_path`, no `name`-as-key, no `name`-as-tag.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- Tool descriptions in `tools.ts` and `SERVER_INSTRUCTIONS` in `server.ts` reflect the new names.
- `README.md` examples reflect the new names.
- `AGENTS.md` carries the parameter dictionary so the rule is discoverable.
- `2.0.0` in `package.json` + matching `CHANGELOG.md` entry, produced by `commit-and-tag-version`.
