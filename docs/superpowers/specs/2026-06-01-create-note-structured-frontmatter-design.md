---
date: 2026-06-01
status: accepted
---

# create_note — structured `frontmatter` parameter

## Problem

`create_note` has no way to set frontmatter as data. The only channel is to hand-roll a YAML block inside `content`:

```
content: "---\ntype: task\ntags:\n  - mcp\n---\n# Title\n…"
```

Almost every note in the vault carries frontmatter (`type`, `created`, `tags`, often `status`/`project`), so an LLM caller hits this on nearly every `create_note`. Hand-rolling YAML is a repeated footgun: quoting `[[wikilink]]` values (a leading `[` is a YAML flow sequence), date formatting, and tag-list shape are all easy to get subtly wrong, and the failure is silent — the file is written, just malformed.

This was surfaced in DX feedback (the call was `create_note(frontmatter: {type, tags})` — a parameter that did not exist). The first half of that feedback — strict rejection of unknown top-level parameters (`.strict()`) — shipped separately on `fix/strict-unknown-params`. That makes the bad call fail loudly instead of silently dropping the argument, but the ergonomic root cause remains until there is a structured way to pass frontmatter. (The originating task note was itself authored with a hand-written `content` frontmatter block — exactly the hole this closes.)

## Goals

- `create_note` accepts an optional `frontmatter` parameter as structured data.
- Serialization produces standard, Obsidian-compatible YAML: `[[wikilink]]` values quoted, `YYYY-MM-DD` dates preserved, tags as a list.
- When `frontmatter` is absent, behavior is byte-for-byte unchanged (back-compat).
- The serializer is the clean inverse of the existing `splitFrontmatter` reader — written frontmatter round-trips back to the same object.
- Regression coverage for the serializer and for the `create_note` round-trip.

## Non-goals

- Typing the frontmatter keys. The vault has 30+ open properties; `frontmatter` is free-form `Record<string, unknown>`. Typos _inside_ frontmatter are not caught — an accepted trade-off (top-level `.strict()` does not cover nested keys).
- Auto-injecting `created` / `type` / any default key. The caller decides what frontmatter a note gets.
- Custom validation messages beyond Zod's defaults.
- Changing how `set_property` serializes frontmatter (it delegates to obsidian-cli). See Risk.

## Design

### `serializeFrontmatter(fm)` — `src/lib/obsidian/frontmatter.ts`

New exported function, the inverse of the `splitFrontmatter` already in this file. Adds a `stringify` import alongside the existing `parse`:

```ts
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function serializeFrontmatter(fm: Record<string, unknown>): string {
  return `---\n${stringifyYaml(fm)}---\n`;
}
```

`yaml` is already a dependency (used for parsing); this is the first use of its `stringify`. `stringifyYaml` emits a trailing newline, so `stringifyYaml({ type: 'task' })` is `"type: task\n"` and the wrapped result is `---\ntype: task\n---\n`. It quotes flow-sequence-leading strings (`"[[neuro-vault]]"`), keeps `YYYY-MM-DD` dates as plain scalars, and renders arrays as block lists — i.e. the shape `splitFrontmatter` already reads back.

The function is not responsible for the empty-object case; that is handled at the tool layer (see below) so the serializer never receives `{}` in normal flow. A defensive test documents that `serializeFrontmatter({})` returns `---\n{}\n---\n` (the raw `yaml.stringify({})` output) — callers must not pass `{}`.

### `create_note` gains `frontmatter?: Record<string, unknown>`

The new parameter and all composition logic live in `src/modules/operations/tools/create-note.ts`. The provider (`obsidian-cli-provider.ts`) and the `CreateNoteToolInput` type are **untouched** — the tool layer composes a single `content` string and passes it through the existing `content=` CLI token. The provider stays a thin CLI wrapper.

Schema: add `frontmatter: z.record(z.unknown()).optional()` to the input schema. (`.strict()` on the top-level object, added in the prior fix, still applies — `frontmatter` becomes a known key.)

Handler logic, after the existing `name`/`path` validation and before calling the provider:

```ts
const hasFrontmatter = input.frontmatter !== undefined && Object.keys(input.frontmatter).length > 0;

if (hasFrontmatter) {
  const { frontmatter: contentFm, content: body } = splitFrontmatter(input.content ?? '');
  const merged = { ...(contentFm ?? {}), ...input.frontmatter! };
  passthrough.content = serializeFrontmatter(merged) + body;
} else if (input.content !== undefined) {
  passthrough.content = input.content;
}
```

Three cases:

- **`frontmatter` absent** → current verbatim behavior. `content` is passed through as-is (including any frontmatter the caller embedded). Back-compat path, unchanged.
- **`frontmatter` is `{}`** → treated as absent (the `Object.keys(...).length > 0` guard). The empty object is a no-op, not an empty `---\n---\n` block and not an error. `content` passes through verbatim.
- **`frontmatter` present and non-empty** → `splitFrontmatter(content)` parses any frontmatter block the `content` carried into `contentFm` and separates the `body`; the param is **merged over** `contentFm` and the serialized merged block is prepended to that body.

### Conflict resolution: merge, param wins on key collision

When `frontmatter` is supplied **and** `content` also carries its own `---` block, the two are **merged key-by-key**: every key the content's frontmatter declared is kept, and the `frontmatter` parameter's keys are layered on top — so on a key collision the **parameter wins** (`{ ...contentFm, ...param }`). Keys present only in the content's frontmatter survive; keys present only in the param are added.

This supersedes two earlier decisions, in order: the originating task note proposed rejecting the both-present case with `INVALID_PARAMS`; the first iteration of this spec chose wholesale replacement (param entirely discards content's frontmatter). The final decision is key-merge with param precedence, because:

1. It is the least surprising and least lossy: a caller who embedded `created`/`type` in `content` and passes `tags` as a param gets all of them, rather than silently losing the embedded keys.
2. The both-present case stops being a "misuse to tolerate" and becomes a useful composition: `content` carries a template's baseline frontmatter, the param overrides/extends specific fields.
3. Precedence is unambiguous: the explicitly-passed `frontmatter` parameter is the more intentional channel, so it wins ties.

Implementation uses `splitFrontmatter` (not the regex-only `splitRawFrontmatter`) because the merge needs the content's frontmatter **parsed** into an object. `splitFrontmatter` never throws — on malformed YAML in the content block it returns `frontmatter: null` and leaves the raw text in `content`; the handler then merges nothing (`contentFm ?? {}`) and the unparseable text stays in the body (see Error handling).

No blank line is injected between the serialized block and the body — `block + body` directly — so the result round-trips exactly through `splitFrontmatter` (whose closing-fence regex does not require a following blank line). Key ordering in the output follows JS object-spread order: content-only keys first (in their original order), then param keys, with a colliding key keeping its original position but taking the param's value.

### Tool description

Extend the `create_note` description so MCP clients see the structured channel. Add, near the existing `content` clause:

> Optionally provide `frontmatter` (an object of frontmatter properties) — it is serialized to a YAML block prepended to the note. Prefer this over hand-writing a `---` block inside `content`; it quotes `[[wikilinks]]`, formats dates, and renders tag lists correctly. If `content` also begins with its own `---` block, the two are merged key-by-key and the `frontmatter` parameter wins on any key collision (the content's body is kept).

The existing convention-sampling guidance (sample neighbour notes, reuse the closed `type` set) and the destructive-`overwrite` language are preserved.

### Architectural location

`serializeFrontmatter` belongs in `src/lib/obsidian/frontmatter.ts` next to its inverse `splitFrontmatter` — one file owns the frontmatter ↔ object boundary in both directions. The composition logic is a tool-layer concern (`create-note.ts`), the same layer as the existing `name`/`path` mutual-exclusion and `content`/`template` rules. No new module, no architecture-doc change: this extends the existing frontmatter concept rather than introducing a new one.

## Error handling

- `frontmatter` present and non-empty → content's own frontmatter (if any) parsed and merged under the param; serialized and prepended. No error.
- `frontmatter` present, and `content`'s own frontmatter block is **malformed YAML** → `splitFrontmatter` returns `frontmatter: null` and leaves the raw `content` intact; the handler merges nothing and prepends the param block, so the unparseable text remains in the body (a double-block result). This is a rare, non-fatal fallback — no data is lost and no error is raised. (Choosing `splitFrontmatter` over `splitRawFrontmatter` is what enables the merge; the trade-off is this edge case, accepted.)
- `frontmatter` is `{}` or absent → verbatim `content` passthrough. No error.
- `frontmatter` not an object (e.g. array, string) → Zod `z.record(z.string(), z.unknown())` rejects at the schema boundary with the standard validation error, before the handler runs.
- All existing `create_note` errors (missing/duplicate identifier, empty name, overwrite collision, post-write existence check) — unchanged.

## Testing strategy

`serializeFrontmatter` (unit, `test/.../frontmatter.test.ts` or a new sibling):

- Wikilink value → quoted (`project: "[[neuro-vault]]"`).
- Date string `2026-06-01` → plain scalar, not re-quoted/reformatted.
- Tag array → block list.
- Nested object/array value → valid nested YAML.
- Defensive: `serializeFrontmatter({})` documented output.

`create_note` + `frontmatter` (tool-layer test, `test/operations/tools/create-note.test.ts`):

- Round-trip: handler is called with `frontmatter` + body `content` (no embedded frontmatter); assert the provider receives a combined `content` whose `splitFrontmatter` yields exactly the input `frontmatter` object and the input body (written == read).
- `content` carrying its own `---` block **plus** `frontmatter` → provider's content has the **merged** frontmatter: content-only keys survive, param keys are added, and a colliding key takes the param's value. Body preserved.
- `frontmatter: {}` → provider receives the verbatim `content` (treated as absent).
- `frontmatter` absent → verbatim passthrough (existing behavior, regression-guarded).

Ideally a shared round-trip test asserting `splitFrontmatter(serializeFrontmatter(fm))` ≍ `fm` for a representative object, to keep the two halves consistent over time.

Gates: `npm test`, `npm run lint`, `npx tsc --noEmit` all green.

## Definition of Done

- `create_note` accepts `frontmatter?: Record<string, unknown>`; non-empty values are serialized and prepended, empty/absent values are a verbatim passthrough.
- `serializeFrontmatter` exported from `src/lib/obsidian/frontmatter.ts`, round-trips with `splitFrontmatter`.
- When both `frontmatter` and an embedded `content` frontmatter block are present, the two are merged key-by-key with the param winning on collisions; the body is preserved.
- Tool description documents the parameter and the merge rule.
- Tests cover serializer cases, the round-trip, the merge case (param wins on collision, content-only keys survive), the empty-object no-op, and the absent passthrough.
- User-facing reference updated in the same change: `docs/guide/vault-operations.md` (the per-tool reference). The top-level `README.md` has no per-tool `create_note` entry — only a feature-level bullet that already covers frontmatter — so no README change is required.
- `npm test`, `npm run lint`, `npx tsc --noEmit` green.
- Shipped as a `feat` (minor bump) from `main` via `npm run release` after the PR merges, per the project release flow.

## Risk

Two frontmatter-serialization paths now exist: `create_note` (new, `yaml.stringify`) and `set_property` (delegates to obsidian-cli). Accepted — `yaml.stringify` produces standard Obsidian-compatible YAML — but worth keeping consistency in view; shared round-trip tests are the guard if the two ever drift.

## Connections

- Inverse of `splitFrontmatter` / `splitRawFrontmatter` in the same file — same frontmatter boundary, opposite direction.
- Continues the body/frontmatter redesign line from `2026-05-06-edit-note-in-place-design.md`, which introduced the byte-preserving split; this is the reverse serialization.
- Second half of the DX feedback whose first half shipped as `fix/strict-unknown-params` (strict rejection of unknown top-level params). That fix makes a bad `frontmatter` call fail loudly; this gives the call something real to land on.
- Sibling to `2026-05-12-create-note-content-template-conflict-design.md` — both are `create_note` tool-layer input-composition rules.
