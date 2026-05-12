# `read_daily` — materialize today's notes

## Goal

Make `read_daily` answer "what's on my agenda?" / "what happened today?" from
one call. Today the tool returns only the daily note itself, which is often
near-empty ("- [ ] Chill"), while the actual content of the day lives in
separate notes (reflections, new tasks, ideas) tagged with
`frontmatter.created = <today>`. Callers must remember to follow up with a
`query_notes` call, and routinely don't. The tool description already promises
the agenda use case; this spec closes the gap between contract and behavior.

The change is purely additive — a new `notes_today` field is appended to the
existing return shape, so existing callers keep working unchanged.

## Scope

- Add `notes_today: Array<{ path, frontmatter, backlink_count }>` to the
  `read_daily` return shape (each item's `frontmatter` is non-null — only notes
  with a parseable `frontmatter.created` value can match the filter).
- Always populated, no caller-facing parameters.
- Metadata only — no `content`, no `tags`. Callers fetch bodies they care
  about via `read_notes`.
- Hard cap at 200 entries; if the query engine reports more, the array is
  truncated silently (no extra flag in v1).
- Sorted by `path` ascending, stable.
- Update the tool description, the server prompt mention of `read_daily`,
  and the vault-operations guide example.

### Out of scope (v1)

- `tasks_today` (open tasks for the day) — separate task if needed.
- Including `content` in `notes_today` entries.
- `read_daily(date)` with an arbitrary date.
- Any time-of-day / weekday awareness — that is the caller's / skill's
  responsibility.

## Architecture

`read_daily` becomes a composing tool: it calls `provider.readDaily()` for the
daily note itself and `runQueryNotes(...)` for `notes_today`, then merges the
two results. The `VaultProvider` interface does not change, and the
`ObsidianCLIProvider` does not gain new responsibilities — the "notes created
today" query is read-from-disk work that the existing query engine already
performs, and routing it through the CLI would be both slower and unnecessary.

```
buildReadDailyTool(deps: { provider, reader, graph })
  ├── provider.readDaily()                → { path, frontmatter, content }
  ├── derive today from path basename     → "YYYY-MM-DD"
  └── runQueryNotes(filter, reader, graph) → notes_today[]
```

### Determining "today"

The date comes from the basename of the path returned by `provider.readDaily()`
(`Daily/2026-05-12.md` → `2026-05-12`). This guarantees that "today" in
`notes_today` is exactly the day the daily-notes plugin treats as today,
regardless of timezone or plugin configuration.

If the basename does not match `^\d{4}-\d{2}-\d{2}` (unconventional vault
layout), fall back to the local date formatted as `YYYY-MM-DD`. The fallback
is a safety net; the primary path is the basename.

### Matching `frontmatter.created`

The `created` frontmatter value may be either a plain date (`2026-05-12`) or
an ISO datetime (`2026-05-12T10:30:00`). The filter uses a prefix regex to
cover both:

```ts
runQueryNotes(
  {
    filter: {
      'frontmatter.created': { $regex: `^${today}` },
      'frontmatter.type': { $ne: 'daily' },
    },
    sort: { field: 'path', order: 'asc' },
    limit: 200,
  },
  reader,
  graph,
);
```

The regex is anchored to the start of the value, so `2026-05-12` matches both
`2026-05-12` and `2026-05-12T10:30:00`, but not `2026-05-120` or any other
date.

The `daily` exclusion uses `frontmatter.type: { $ne: 'daily' }`, matching the
vault's `Templates/Daily.md` convention (`type: daily`).

### Shaping the result

`runQueryNotes` returns entries with `{ path, frontmatter, tags, backlink_count, content? }`. The tool projects each entry down to
`{ path, frontmatter, backlink_count }`, dropping `tags` and ensuring
`content` never leaks even if a future default flips. The projection happens
in the tool handler, not in `runQueryNotes`.

## Interfaces

### Return shape

```ts
{
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
  notes_today: Array<{
    path: string;
    frontmatter: Record<string, unknown>;
    backlink_count: number;
  }>;
}
```

### Tool description (new)

> Read today's daily note. Returns `{ path, frontmatter, content, notes_today }` where `frontmatter` is the parsed YAML object (or `null` if absent/malformed), `content` is the body without the YAML block, and `notes_today` lists vault notes created today (matched by `frontmatter.created`) excluding daily notes themselves — metadata only, sorted by path ascending, capped at 200 entries. Useful for "what's on my agenda?" / "what happened today?" questions without a separate `query_notes` call.

### Dependency wiring

`buildReadDailyTool` gains `reader: VaultReader` and `graph: WikilinkGraphIndex`
in its `deps`. The server registration site already constructs both for the
existing `query_notes` and `get_note_links` tools, so the wiring is a
parameter pass-through.

## Error handling

`read_daily` keeps its current error surface for the daily-note half
(`CLI_*`, `NOT_FOUND` from the provider). The `notes_today` half is best-effort
in the sense that callers should always be able to read the daily note even
if the query engine returns nothing — but `runQueryNotes` already does not
throw for an empty result, and any genuine error from the reader or graph
propagates as a `ToolHandlerError` (the standard error path). We do not swallow
errors from the query engine; if the vault index is in a broken state, the
caller should see it.

## Testing

Tests live in `test/operations/tools/read-daily.test.ts`. The fake provider
and query engine are stubbed at the dependency boundary (`reader`, `graph`)
the same way the existing `query_notes` tests stub them.

Cases (each maps to one of the spec's test bullets):

1. Daily has no notes created today → `notes_today` is `[]`.
2. Daily has multiple notes created today of various types → all returned,
   `type: daily` excluded.
3. A note has `frontmatter.created` as an ISO datetime
   (`2026-05-12T10:30:00`) — it still matches.
4. Notes are sorted by `path` ascending, deterministically.
5. Each `notes_today` entry contains only `path`, `frontmatter`,
   `backlink_count` — no `content`, no `tags`.
6. Tool description matches the actual return shape (spot-check by
   re-reading the description in the registration assertion that already
   exists in `test/operations/tools.test.ts`).
7. Cap behavior: when the query engine returns more than 200 candidates,
   `notes_today.length === 200` and the truncation is silent. (Verified by
   stubbing the engine to return 201 items.)

The integration-style smoke test in `test/operations/tools.test.ts` is
updated to assert the new field exists on the result.

## Migration / compatibility

Additive change. Existing clients that destructure `{ path, frontmatter, content }`
keep working. No version bump is required for backwards compatibility; this
ships as a minor (`feat:`) under the next release.

## Definition of Done

- `read_daily` returns `notes_today` matching the schema above.
- Tool description is updated and the description in the server prompt
  mentions the new field (one line; do not duplicate the schema).
- Unit tests cover: empty case, non-empty case, daily-type exclusion,
  ISO-datetime `created` matching, `path` asc sort, projection (no
  `content`/`tags`), and cap-at-200.
- `docs/guide/vault-operations.md` has one updated example showing the new
  field. `README.md` mentions it in the `read_daily` blurb.
- `npm test`, `npm run lint`, `npx tsc --noEmit` all pass.
- Conventional commit: `feat(read_daily): include notes_today in result`.

## Connections

- Source task in vault: `Tasks/Materialize today's notes in read_daily.md`.
- Related vault tasks (not implemented here): `Tasks/Ambient vault context retrieval for claudian conversations`,
  `Tasks/Startup baseline context skill for neuro-vault`.
- Existing infrastructure reused: `runQueryNotes` (`src/lib/obsidian/query/`),
  `VaultReader`, `WikilinkGraphIndex`. No new shared modules introduced.
