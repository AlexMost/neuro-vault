---
date: 2026-05-12
status: accepted
---

# create_note — reject simultaneous content and template

## Problem

`create_note` accepts both `content` and `template` parameters and silently forwards both to the Obsidian CLI. When both are supplied, the CLI applies the template skeleton and discards the caller's `content`. Result: the caller believes they wrote a full note, but the file on disk is the empty template stub.

Reproduced on 2026-04-29 while creating `Reflections/2026-04-29 — moby monetization.md`: `create_note` was called with `path`, full markdown `content`, and `template: "Reflection"`. The file ended up containing only the Reflection template skeleton — the caller's body and most of the frontmatter were dropped without any signal that this happened.

Root cause is at the MCP boundary, not in the CLI: the tool has no policy about what "both content and template" means, so it forwards both and inherits whatever the CLI happens to do. The CLI's behavior is reasonable on its own (template wins), but for a tool meant to be driven by an LLM the silent discard is the worst possible failure mode — the model gets a success response and moves on.

## Goals

- `create_note` does not silently drop caller-supplied `content` when a `template` is also provided.
- The conflict is surfaced as a structured validation error (`INVALID_ARGUMENT`) so the calling LLM/client can react.
- The error message names both parameters and tells the caller what to do instead.
- Regression coverage exists for the conflict and for each side used alone.

## Non-goals

- Defining a merge semantics between `content` and `template` (frontmatter overlay, body insertion, Templater handling). Out of scope; the cost of a well-defined merge is much higher than the value compared to a clean either/or rule.
- Changing how the Obsidian CLI handles the case when only one of the two is set. The CLI behavior for `content`-only and `template`-only paths is fine.
- Changing the parameter names or adding new ones (no `body`, `prepend`, `append`, etc.).
- Touching other tools that take `template` (none exist today; `edit_note`, `set_property` etc. do not template).

## Design

### Rule

In `create_note`, exactly the same shape as the existing `name` xor `path` check:

> If both `content` and `template` are provided, throw `INVALID_ARGUMENT`. Either is allowed alone, neither is allowed (resulting note is empty), but not both together.

### Error shape

Use the existing `invalidArgument(message, field)` helper. The error structure already in use by other tools:

```ts
throw invalidArgument(
  'content and template cannot be used together — call create_note with only one. If you want a note pre-filled from a template, call without content; if you want to write exact markdown, call without template.',
  'content',
);
```

`field: 'content'` rather than `'template'` because the more common caller intent is "I want my content saved" — pointing the error at the parameter that is being dropped makes the message most actionable.

### Where the check lives

In `src/modules/operations/tools/create-note.ts`, alongside the existing `name`/`path` validation, before the `passthrough` object is built. Order of checks in the handler becomes:

1. `name` xor `path` (existing).
2. `name` non-empty (existing).
3. **New:** `content` xor `template` when either is set — reject if both are set.
4. Normalize, build passthrough, call provider (existing).

The provider layer (`obsidian-cli-provider.ts`) is unchanged. Provider-level checks would also catch this, but the tool layer is the right place: the rule is a tool contract, not a CLI quirk, and we already do `name`/`path` validation there.

### Tool description

Update the tool's `description` string so MCP clients (LLMs) see the constraint up front. New wording:

> "Create a new note. Provide `name` or `path` (exactly one). Optionally provide `content` (raw markdown for the note body and frontmatter) OR `template` (name of a vault template to apply) — these are mutually exclusive. If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists."

The existing destructive-write language is preserved; only the content/template clause is rewritten.

### Architectural location

This is a single-file change in the operations tool layer. No new modules, no new helpers — `invalidArgument` already exists. No architecture doc needs updating: the change is at the same layer as the existing `name`/`path` mutual-exclusion rule, which is itself not separately documented.

## Error handling

- Both `content` and `template` set → `ToolHandlerError` with code `INVALID_ARGUMENT`, field `content`, message as above. No CLI call is made.
- Only `content` set, only `template` set, or neither set → unchanged passthrough behavior.
- All other existing errors (missing identifier, empty name, overwrite collisions surfaced by the CLI, etc.) — unchanged.

## Testing strategy

`test/operations/tools/create-note.test.ts` gets new cases. The existing test on lines 13–27, which currently passes both `content` and `template` together, must be updated — it's currently asserting the buggy behavior. New cases:

- `content` and `template` together → handler throws `ToolHandlerError` with code `INVALID_ARGUMENT` and field `content`; provider is never called.
- `content` alone → provider receives `content` and no `template`.
- `template` alone → provider receives `template` and no `content`.
- Neither set → provider receives neither (existing minimal-create behavior).
- Combined with `name`/`path` validation order: when `name` is also missing, the `name`/`path` error fires first (i.e., we don't reorder checks in a way that changes which error wins).

`test/operations/obsidian-cli-provider.test.ts`: the test on lines 7–22 that currently passes both `content` and `template` to the provider should drop `template` (or split into two tests, content-only and template-only). The provider itself doesn't know about the rule; we just stop exercising the now-impossible combination through it.

No new integration tests against a live vault are needed — the rule is purely at the tool layer and the unit tests fully cover it.

## Definition of Done

- `create_note` rejects simultaneous `content` and `template` with `INVALID_ARGUMENT`.
- Tool description in `create-note.ts` reflects the mutual-exclusion rule.
- Unit tests cover the four combinations (both, content-only, template-only, neither) and the validation ordering vs `name`/`path`.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all green.
- README's `create_note` entry mentions the constraint if such an entry exists; otherwise no README change needed.
- Patch release published from `main` via `npm run release` after the PR merges (per the project release flow).

## Connections

- Mirrors the existing `name` xor `path` validation in the same tool — same shape, same helper, same error code.
- Workaround documented in the originating task note (`Tasks/Fix create_note content handling with templates.md`): call `create_note` without `template` when you have full markdown ready. This stays the recommended pattern; the spec just makes the alternative loud instead of silent.
