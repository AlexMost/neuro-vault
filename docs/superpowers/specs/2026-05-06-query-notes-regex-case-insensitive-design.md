# `query_notes` — case-insensitive `$regex` by default

Date: 2026-05-06
Status: accepted

## Goal

Make `$regex` in `query_notes` filters case-insensitive by default so an LLM
can search vault content without having to reason about exact letter casing
(`#AI` vs `#ai`, `Active` vs `active`, etc.).

## Motivation

`query_notes` filters are evaluated by `sift` and ultimately run through JS
`RegExp`, which is case-sensitive by default. In practice the LLM client
almost always wants a case-insensitive match — vault tags and frontmatter
values are written by humans with inconsistent casing. Today the LLM has no
way to pass `$options` either, because `$options` is not on the whitelist.

The change reduces ceremony for the common case and gives explicit opt-out
for the rare case where a caller really wants case-sensitive matching.

## Scope

- `src/lib/obsidian/query/whitelist.ts` — add `$options` to the allowed set.
- `src/lib/obsidian/query/query-notes.ts` (or a new file in the same dir) —
  inject default `$options: 'i'` before handing the filter to sift.
- `src/server.ts` and `src/modules/operations/tools/query-notes.ts` — update
  the inline tool descriptions.
- `docs/guide/vault-operations.md` — document the new default and opt-out.

Out of scope:

- `search_notes` (semantic search), other tools.
- Any change to `$regex` semantics beyond the default flag.

## Behavior

For each filter clause that contains `$regex`:

| Caller writes                       | Effective `$options`                   |
| ----------------------------------- | -------------------------------------- |
| `{ $regex: 'foo' }`                 | `'i'` (injected)                       |
| `{ $regex: 'foo', $options: 'i' }`  | `'i'` (unchanged)                      |
| `{ $regex: 'foo', $options: '' }`   | `''` (opt-out, case-sensitive)         |
| `{ $regex: 'foo', $options: 'm' }`  | `'m'` (multiline only, case-sensitive) |
| `{ $regex: 'foo', $options: 'mi' }` | `'mi'` (unchanged)                     |

Rule: **if the clause has `$regex` and no `$options` key, inject
`$options: 'i'`. If the caller provided `$options` explicitly — even an empty
string — use exactly what they provided. No merging.**

The default applies wherever `$regex` is legal: top-level fields, inside
`$and`, `$or`, `$nor`, `$not`, etc.

## Architecture

Two pieces:

1. **Whitelist update.** Add `$options` to `ALLOWED_OPERATORS`. The whitelist
   is purely structural (does it know this `$key`?), so allowing `$options`
   without `$regex` would not crash anything; sift would just ignore it. Not
   worth a special semantic check.

2. **Default-options pass.** A pure function
   `applyDefaultRegexOptions(filter: unknown): unknown` that walks the filter
   tree and returns a new tree where every object containing `$regex` and
   missing `$options` has `$options: 'i'` added. It does not mutate the
   input. It runs in `runQueryNotes` after `validateFilter` and before
   `sift(...)`.

   Walk rules:
   - Plain objects: copy keys; if the object has `$regex` and not
     `$options`, set `$options: 'i'` in the copy. Recurse into every value.
   - Arrays: map and recurse.
   - Primitives: return as-is.

   The function lives next to the whitelist (e.g. a new
   `default-regex-options.ts` in `src/lib/obsidian/query/`) so the query
   pipeline reads top-to-bottom: validate → apply defaults → run sift.

## Error handling

No new error paths. `$options` reaching sift with an unsupported flag would
surface as an existing `INVALID_FILTER` error from sift via the existing
`try/catch` around `sift(filter)`.

## Testing strategy

Vitest, mirroring existing structure.

1. **Whitelist test** (`test/lib/obsidian/query/whitelist.test.ts`):
   - `$options` is accepted alongside `$regex`.

2. **Default-options unit test** (new file, e.g.
   `test/lib/obsidian/query/default-regex-options.test.ts`):
   - Injects `$options: 'i'` when `$regex` has no options.
   - Leaves explicit `$options` untouched, including `''`, `'m'`, `'mi'`.
   - Works inside `$and`, `$or`, `$nor`, `$not`.
   - Returns the input shape unchanged when there is no `$regex`.
   - Does not mutate the input (caller's filter object is unchanged after
     the call).

3. **Integration test** (extend
   `test/lib/obsidian/query/query-notes.test.ts` or whichever file already
   exercises `runQueryNotes` end-to-end against a temp vault):
   - `{ tags: { $regex: '^ai' } }` matches a note tagged `AI`.
   - `{ tags: { $regex: '^ai', $options: '' } }` does NOT match `AI`.

## Documentation & release

- `docs/guide/vault-operations.md`: add a sentence under the `$regex` row
  describing the new default and the `$options: ''` opt-out.
- `src/server.ts` and `src/modules/operations/tools/query-notes.ts`: a short
  clause appended to the existing description (something like "regex is
  case-insensitive by default; pass `$options` to override").
- README: no change needed (it links out to the guide).
- Release: minor bump (`4.2.0`). Old filters remain valid; the only
  observable change is that previously case-sensitive matches now match more
  notes. Acceptable per project policy — breaking changes are not a
  concern at this stage.

## Definition of Done

- [ ] `$options` whitelisted; whitelist test covers it.
- [ ] `applyDefaultRegexOptions` implemented as a pure, immutable transform
      with full unit coverage of the cases above.
- [ ] `runQueryNotes` calls `applyDefaultRegexOptions` after `validateFilter`
      and before `sift(...)`.
- [ ] Integration test asserts both the default-on and the opt-out paths.
- [ ] Tool descriptions in `src/server.ts` and the operations tool file
      mention the new default.
- [ ] `docs/guide/vault-operations.md` updated.
- [ ] `npm test`, `npm run lint`, `npx tsc --noEmit` all clean.
