# Reading & Modifying

> All operations on this page — reads and writes — go directly against the vault directory on disk. None of them require Obsidian to be installed or running.

Every write tool (`create_note`, `edit_note`, `set_property`, `remove_property`) writes directly to disk. If you have Obsidian open on the same vault, its own file watcher picks up the change on its usual cadence — there is no separate fast path through the app.

`read_notes` reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

**Per-vault failures.** When a fan-out tool (`list_tags`, `list_properties`, `query_notes`, `get_vault_overview`, `search_notes`) is called in multi-vault mode without an explicit `vault:`, per-vault failures do not abort the whole call. Successful vaults still return their results in `results_by_vault`; the failing vault appears in a `failed_vaults` array with its error code, message, and details. `failed_vaults` is always present (empty array when nothing failed). See [docs/architecture/fan-out.md](../architecture/fan-out.md) for the full contract.

**Wikilink graph failures.** Some tools read the vault's wikilink graph: `get_note_links`, `query_notes` and `read_daily` (each note's `backlink_count`), `get_vault_overview` and the `vault://overview` resource (top notes by backlinks), `search_notes`, and `get_similar_notes`. The graph usually sits in a shared background process. When it cannot answer (it did not respond in time, was restarted mid-call, or failed to build the graph), a tool call fails for that vault with `DEPENDENCY_ERROR`, message `"Graph read failed"` and `details: { vault, operation }`, where `operation` is the tool's name. In a fan-out, that vault goes to `failed_vaults` and the others still answer. A `vault://overview` resource read fails with a protocol error whose message is `"Graph read failed"` and whose `data` is `{ code: "DEPENDENCY_ERROR", details: { vault, operation } }`, where `operation` is the resource's URI. The underlying reason goes to the server's stderr, not to the response. Retrying is safe: the next call reconnects.

Most tools on this page accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`. `read_notes` accepts `paths` only (no wikilink resolution); if you only have a note name, resolve it to a path with [`search_notes`](./finding-notes.md) first.

## Notes

### `read_notes`

Read one or more notes directly from disk — whole, or one heading block or line range of each. Returns per-item results in input order; a failed item carries an error rather than aborting the whole call. Does not require Obsidian to be running.

```typescript
read_notes({
  paths: Item | Item[],                                       // 1–50 items
  content?: 'full' | 'preview' | 'outline' | 'frontmatter',   // optional; default derived per item
})

type Item =
  | string                                    // the whole note
  | { path: string }                          // same as the string
  | { path: string; heading: string }         // one heading block, by heading name
  | { path: string; lines: [number, number] } // one line range
```

An item names the note and, optionally, a **selection**: the part of the note to read. A bare path selects the whole body. An item takes at most one selector — `heading` and `lines` together fail the whole call with `INVALID_ARGUMENT`. To read several parts of one note, repeat the path with a different selector. Exact duplicates (same path, same selector) are de-duplicated; results keep input order. The 50-item cap counts items, not distinct notes.

#### Line coordinates

Every `lines` value — the `lines` selector, every `lines` in a result, and the evidence `lines` of [`search_notes`](./finding-notes.md#output-shape) — is `[start, end]` in **file-relative, 1-based, inclusive** line numbers. Frontmatter lines are counted, so a note whose frontmatter occupies lines 1–4 has a body starting on line 5. A search hit's `lines` reads back unchanged.

Returned text is verbatim (no line numbers inside it), so it can be pasted into [`edit_note`](#edit_note) `replace`. Each item that returns body coordinates echoes its span in `lines` instead.

A `lines` selector is clipped to the body at both ends: a range that starts inside the frontmatter begins at the first body line, and one that runs past the end stops at the last line. The echoed `lines` shows the span actually returned. A range that shares no line with the body is a miss (`LINES_OUT_OF_RANGE`, below).

#### `content` modes

`content` applies to each item's selection exactly as it applies to a whole note. The modes form a ladder; each rung shows more of the selection than the one before:

| Mode          | Returns                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `frontmatter` | `{ path, frontmatter }` — no body, no coordinates                                                                                    |
| `outline`     | `{ path, frontmatter, lines, preamble?, outline, collapsed? }` — the heading blocks of the selection, no text                        |
| `preview`     | everything in `outline`, plus `content` (the selection's first 500 characters, verbatim) and `truncated`                            |
| `full`        | `{ path, frontmatter, lines, content }` — the whole selection; a heading read also echoes `heading` and `level`                     |

- `lines` on the item is the selection's span. For a whole note it is the body span, `[first body line, last line]`, so the frontmatter ends on `lines[0] − 1`.
- `preamble: [start, end]` is the note's text before its first heading, intersected with the selection, and is present only when that text is non-blank. A heading read never has one.
- `truncated: true` means the preview `content` stops before the selection's end.

**Default when `content` is omitted:** a selector item returns its selection in `full`; a bare path returns `full` when the call has one item and `preview` otherwise (counting every item, selector items included). An explicit `content` applies to every item in the call.

#### The outline

```json
{
  "path": "logs/2026.md",
  "frontmatter": { "type": "resource" },
  "lines": [4, 1225],
  "outline": [
    { "heading": "Work log", "level": 1, "lines": [5, 1225] },
    { "heading": "2026-01", "level": 2, "lines": [7, 111], "hidden": 9 },
    { "heading": "2026-02", "level": 2, "lines": [112, 212], "hidden": 8 }
  ],
  "collapsed": true
}
```

- **Entries are flat, in source order.** `level` is the `#` count (1–6); nesting shows in `level` and in nested `lines`.
- **An entry's `lines` is its whole heading block:** from the heading line through the line before the next heading of the same or higher level, sub-headings included. A heading read of that entry returns exactly this span.
- **`heading` is the heading name** — the heading's text as written, with `[n]` on a repeat among siblings (`Notes[2]` is the second `Notes` under the same parent). Pass it unchanged as `{ path, heading }`. It is the same string semantic `search_notes` `blocks[].heading` carries.
- **Own text** — a heading's lines before its first sub-heading — runs from the entry's `lines[0]` to the next entry's `lines[0] − 1` when that next entry starts inside the entry's `lines`, and is the whole entry otherwise. In the [structured preview example](#structured-preview) below, "First 30 days" `[14, 22]` is followed by "Week 1" `[18, 22]`, so its own text is lines 14–17: read it with `{ path, lines: [14, 17] }`.
- **Only root-level ATX headings** (`#` … `######` at the start of a line) are heading blocks. Setext headings and headings inside lists or blockquotes are not listed and cannot be read by `heading`.
- **A note without headings** returns `outline: []` and a `preamble` covering the body.

**Collapse.** An outline lists at most 100 entries. Past that, the deepest nesting level is dropped until the outline fits, and the item carries `collapsed: true`. An entry whose sub-headings were dropped carries `hidden: n` — **n sub-headings under it are not listed**. The shallowest level is never dropped. To list what an entry hides, read its outline: `{ paths: [{ path, heading: "2026-01" }], content: "outline" }`. The cap and the collapse count within the selection, so this lists the hidden sub-headings.

#### Structured preview

A preview item is the outline plus a verbatim prefix:

```json
{
  "path": "projects/onboarding.md",
  "frontmatter": { "type": "project" },
  "lines": [5, 41],
  "content": "**Owner:** … | Field | Value | … ## First 30 days …",
  "truncated": true,
  "preamble": [5, 13],
  "outline": [
    { "heading": "First 30 days", "level": 2, "lines": [14, 22] },
    { "heading": "Week 1", "level": 3, "lines": [18, 22] },
    { "heading": "Decisions", "level": 2, "lines": [23, 27] }
  ]
}
```

The prefix is raw text, so it can show headings that a collapsed outline does not list — the outline is not wrong, those headings sit below its cut. To act on a preview, pick the entry and read it by `heading`; re-reading the whole note with `content: 'full'` is rarely needed.

#### Reading a heading block

`{ path, heading }` matches the heading name exactly first. Only when nothing matches exactly, it falls back to a comparison that ignores case, extra whitespace, inline markup, link brackets and leading `#` markers — accepted only if it picks exactly one heading block. The heading's level is not part of the match, and a prefix never matches. A heading read echoes the matched `heading` (as the outline prints it) and its `level` next to `lines`.

#### Misses

A selector that finds nothing fails **its item only**; the other items are unaffected and the item counts toward `errors`. A miss item carries `error: { code, message }` plus retry data under the names successful items use, and no `frontmatter`:

| Code                 | Cause                                                                   | Retry data                                             | Retry with                          |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------- |
| `HEADING_NOT_FOUND`  | no heading block with that name, exactly or by the fallback             | body `lines` + the note's full `outline` (+ `collapsed`) | a `heading` from the outline        |
| `AMBIGUOUS_MATCH`    | the name matches several heading blocks (the same name under different parents) | `matches: [{ heading, level, lines }]`                 | `{ path, lines }` of the one you want |
| `LINES_OUT_OF_RANGE` | the range shares no line with the body                                  | body `lines`                                           | a range inside it                   |
| `NOT_FOUND`          | the note does not exist                                                 | —                                                      | —                                   |

The miss shape is the same under every `content` mode, `frontmatter` included: the selector is always resolved.

Argument faults fail the **whole call** with `INVALID_ARGUMENT`: both `heading` and `lines` in one item, an empty `heading` (a block without a heading is read with `lines`), or a malformed `lines` (it must be two integers with `1 ≤ start ≤ end`; `[a, a]` reads one line).

Successful items always carry parsed `frontmatter`. Before citing or editing, read the part you need in `full`.

Returns `{ results, count, errors }`. `count === results.length` (total items, including failures); `errors` is the subset of those that failed. To get the successful-read count, subtract: `count - errors`.

#### From a search hit to a read

Every `search_notes` evidence row reads back as `{ path, lines: row.lines }` — a semantic `blocks[]` entry and a lexical match alike. Read several hits in one call, one item per hit; with `content` omitted each returns its selection in full.

```json
{
  "paths": [
    { "path": "projects/onboarding.md", "lines": [15, 16] },
    { "path": "logs/2026.md", "lines": [188, 188] }
  ]
}
```

- **`{ path, heading: row.heading }`** is an equal alternative only for a semantic block with a non-empty `heading`; it reads the same span.
- **`heading: ""`** on a semantic block marks a paragraph or preamble block, not a heading block. Read it with `lines`; passing `""` as `heading` fails the whole call.
- **A lexical `heading`** is the text of the nearest heading before the match — a label. It may be tried as an address, but nothing guarantees it names a heading block (it may be a setext heading, a heading inside a list, or one of several siblings with the same text).
- **Check the echo.** A heading read echoes its `lines`. If the hit's `lines` fall outside them, the name picked another block (a sibling duplicate): read the outline and pick by `lines`.
- **The heading block around a hit:** read the outline and take the deepest entry whose `lines` contain the hit's `lines`, then read it by `heading`.

#### Examples

Read a single note (defaults to `full`):

```json
{ "paths": "Projects/neuro-vault.md" }
```

Batch-read several notes (defaults to `preview`: frontmatter, outline and a prefix per note):

```json
{ "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md", "Archive/old-idea.md"] }
```

Outline only, before deciding what to read in a long note:

```json
{ "paths": "logs/2026.md", "content": "outline" }
```

One heading block, and the own text of another (each defaults to `full`):

```json
{
  "paths": [
    { "path": "projects/onboarding.md", "heading": "Decisions" },
    { "path": "projects/onboarding.md", "lines": [14, 17] }
  ]
}
```

Frontmatter only across a list of paths:

```json
{ "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md"], "content": "frontmatter" }
```

### `create_note`

Create a new note. `overwrite: true` is destructive — the AI assistant will ask before passing it.

```typescript
create_note({
  name?: string,
  path?: string,
  content?: string,
  frontmatter?: Record<string, unknown>,
  overwrite?: boolean,
})
```

Paths without an extension are treated as `.md` notes.

Pass `frontmatter` as a structured object rather than hand-writing a `---` block inside `content`; it is serialized to YAML and prepended to the note, with `[[wikilinks]]` quoted, dates formatted, and tag lists rendered as blocks. If `content` also begins with its own `---` block, the two are merged key-by-key: keys from `content` are kept, the `frontmatter` parameter's keys are layered on top, and the parameter wins on any key collision (the body is kept). An empty `frontmatter` object is treated as if it were omitted.

Before composing `content`, sample 1–2 similar notes from the vault to mimic existing conventions — typically [`search_notes`](./finding-notes.md) for the topic, then `read_notes` on the closest match to inspect its frontmatter shape, tag values, heading layout, and folder placement. Match those conventions instead of inventing new ones. Be especially careful with the `type` frontmatter field: vaults tend to use a small closed set; pick from what other notes use rather than coining a new value.

Templates are not handled by this tool. If you want a note pre-filled from an Obsidian template (Core Templates, Templater, or anything else), render it yourself and pass the result as `content`.

### `edit_note`

Edit an existing note. The presence of `replace` selects the mode:

- **With `replace`** — exact-string find/replace inside the body. The string in `replace` is located (case- and whitespace-sensitive) and swapped for `content`. Frontmatter is never touched.
- **Without `replace`** — the entire body is overwritten with `content`. Frontmatter is preserved byte-for-byte. Pre-fetch the body with `read_notes` first if you need to keep parts of it.

```typescript
edit_note({
  name?: string,
  path?: string,
  content: string,
  replace?: string,
});
```

Paths without an extension are treated as `.md` notes.

Both modes write directly to disk and do not require Obsidian to be running.

Errors:

- `INVALID_ARGUMENT` — empty `replace`, both `name` and `path`, neither given.
- `NOT_FOUND` — note path missing, wikilink unresolved, or `replace` text absent in body.
- `AMBIGUOUS_MATCH` — `replace` matches more than once, or a `name` resolves to multiple paths. `details.matches` carries 1-based body line numbers (for replace ambiguity) or candidate paths (for name ambiguity). Resolution: make `replace` more specific, or omit it and rewrite the whole body.

## Daily notes

### `read_daily`

Read today's daily note. Returns:

```typescript
{
  path: string; // canonical path of today's daily note
  frontmatter: Record<string, unknown> | null;
  content: string; // body without YAML block
  notes_today: Array<{
    path: string;
    frontmatter: Record<string, unknown>;
    backlink_count: number;
  }>; // notes created today, type: daily excluded
}
```

`notes_today` is the result of `query_notes({ "frontmatter.created": <today>, "frontmatter.type": { "$ne": "daily" } })`, sorted by `path` ascending, metadata only (no `content`), capped at 200 entries. It exists because the daily note is often near-empty while the real content of the day lives in separate notes tagged with `frontmatter.created`; this saves a follow-up `query_notes` call when answering _"what's on my agenda?"_ or _"what happened today?"_.

The `path` is computed from the daily-notes plugin config; if the note does not yet exist, the result still carries the canonical path so callers can compose with `create_note`. "Today" is derived from the daily-note basename, so the date used to populate `notes_today` is always aligned with the daily-notes plugin's own notion of today.

Fails with `DAILY_NOTES_NOT_CONFIGURED` if the vault has no Daily Notes plugin configured (missing or empty `.obsidian/daily-notes.json`).

### Adding to today's daily note

There is no dedicated `append_daily` tool — compose:

1. `read_daily()` → `{ path, content, ... }` (or `{ path, content: '', ... }` if the note is empty / missing).
2. If the note exists, call `edit_note({ path, content: existingBody + newContent })` (omit `replace` → full-body rewrite).
3. If the note does not exist, call `create_note({ path, content: newContent })`.

The trade-off vs the old `append_daily` is one extra read per write. In an agentic workflow this is invisible — the assistant typically reads daily-note context before writing anyway.

## Properties & Tags

Modify frontmatter and explore tag/property metadata without paying the token cost of reading whole notes. Properties and tags are the metadata an LLM agent updates dozens of times per session — _"mark this task done"_, _"what properties does this vault use?"_, _"how many notes tagged #mcp?"_. Short request, precise answer, no full-note reads. To **read** a specific property value, use [`read_notes`](#read_notes) with `content: 'frontmatter'`.

### `set_property`

Set a frontmatter property on a note. The YAML type is inferred from the JS value (`string` → text, `number` → number, `boolean` → checkbox, `Array` → list). For `date` / `datetime` pass `type` explicitly. List items must not contain commas (a validation retained from the earlier CLI-based implementation).

```typescript
set_property({
  name?: string,
  path?: string,
  key: string,             // property key, e.g. "status"
  value: string | number | boolean | string[] | number[],
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime',
})
```

Returns `{ ok: true }`. Existing properties are overwritten. Paths without an extension are treated as `.md` notes.

### `remove_property`

Remove a frontmatter property. Idempotent — calling it on an absent property succeeds.

```typescript
remove_property({
  name?: string,
  path?: string,
  key: string,
})
```

Returns `{ ok: true }`. Paths without an extension are treated as `.md` notes.

### `list_tags`

List all tags used across the vault, sorted by occurrence count desc.

Returns `[{ name, count }, ...]`.

To list the notes that carry a specific tag, use [`query_notes`](./finding-notes.md#query_notes) with `{ filter: { tags: '<name>' } }`.

### `list_properties`

List **all** frontmatter properties used across the vault, sorted by occurrence count desc.

Returns `[{ name, count }, ...]`.

Unlike `get_vault_overview`, which truncates properties to the top entries, this returns the complete inventory — rare and one-off keys included. That makes it the right tool for property-consistency audits and for checking existing names before introducing a new property.

### `get_vault_overview`

Get a snapshot of your vault's structure in one call. Returns top-level folder counts, top tags, frontmatter properties (top entries — see [`list_properties`](#list_properties) for the full inventory), the total note count, and the top 10 notes by inbound wikilinks. This is the recommended first call for an agent orienting itself in a vault it has not seen before — one call replaces the older `list_tags` + exploratory `query_notes` ritual.

When the vault owner has written a `.neuro-vault/for-external-agents.md`, the response also carries a `conventions` field — their rules for how this vault is organised. Follow them when reading, writing, or organising notes here. The file is re-read on every call, so an edit shows up on the next one without a server restart. The field is absent entirely when the vault has no such file, and a file over 8,000 characters comes back trimmed with `conventions_truncated: true` alongside it.

The same payload is available as the MCP resource `vault://overview`; clients that auto-load resources will pull it without an explicit tool call.
