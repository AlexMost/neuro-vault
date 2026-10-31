# Reading & Modifying

> All operations on this page — reads and writes — go directly against the vault directory on disk. None of them require Obsidian to be installed or running.

Every write tool (`create_note`, `edit_note`, `set_property`, `remove_property`) writes directly to disk. If you have Obsidian open on the same vault, its own file watcher picks up the change on its usual cadence — there is no separate fast path through the app.

`read_notes` reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

**Per-vault failures.** When a fan-out tool (`list_tags`, `list_properties`, `query_notes`, `get_vault_overview`, `search_notes`) is called in multi-vault mode without an explicit `vault:`, per-vault failures do not abort the whole call. Successful vaults still return their results in `results_by_vault`; the failing vault appears in a `failed_vaults` array with its error code, message, and details. `failed_vaults` is always present (empty array when nothing failed). See [docs/architecture/fan-out.md](../architecture/fan-out.md) for the full contract.

**Wikilink graph failures.** Some tools read the vault's wikilink graph: `get_note_links`, `query_notes` and `read_daily` (each note's `backlink_count`), `get_vault_overview` and the `vault://overview` resource (top notes by backlinks), `search_notes`, and `get_similar_notes`. The graph usually sits in a shared background process. When it cannot answer (it did not respond in time, was restarted mid-call, or failed to build the graph), a tool call fails for that vault with `DEPENDENCY_ERROR`, message `"Graph read failed"` and `details: { vault, operation }`, where `operation` is the tool's name. In a fan-out, that vault goes to `failed_vaults` and the others still answer. A `vault://overview` resource read fails with a protocol error whose message is `"Graph read failed"` and whose `data` is `{ code: "DEPENDENCY_ERROR", details: { vault, operation } }`, where `operation` is the resource's URI. The underlying reason goes to the server's stderr, not to the response. Retrying is safe: the next call reconnects.

Most tools on this page accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`. `read_notes` accepts `paths` only (no wikilink resolution); if you only have a note name, resolve it to a path with [`search_notes`](./finding-notes.md) first.

## Notes

### `read_notes`

Read one or more notes directly from disk — whole, or one heading block or line range of each; as an outline of heading blocks, as a preview, or as frontmatter only. Returns per-item results in input order; a failed item carries an error rather than aborting the whole call. Does not require Obsidian to be running.

```typescript
read_notes({
  paths: string | Item[],                                     // one path, or 1–50 items
  content?: 'full' | 'outline' | 'preview' | 'frontmatter',   // optional; default derived per item
})

type Item =
  | string                                    // the whole note
  | { path: string }                          // same as the string
  | { path: string; heading: string }         // one heading block, by heading name
  | { path: string; lines: [number, number] } // one line range
```

An item names a vault-relative note path and, optionally, a **selection**: the part of the note to read. A bare path selects the whole body. An item takes at most one selector. To read several parts of one note, repeat the path with a different selector. Exact duplicates (same path, same selector) are de-duplicated; results keep input order. The 50-item cap counts items, not distinct notes, and a note named by several items is read from disk once.

#### Line coordinates

Every `lines` value — the `lines` selector, every `lines` in a result, and the evidence `lines` of [`search_notes`](./finding-notes.md#evidence-coordinates-and-the-hand-off-to-read_notes) — is `[start, end]` in **file-relative, 1-based, inclusive** line numbers. Frontmatter lines are counted, so a note whose frontmatter occupies lines 1–3 has a body starting on line 4. A block has one coordinate pair across both tools, so a search hit's `lines` reads back unchanged.

Returned text is verbatim (no line numbers inside it), so it can be pasted into [`edit_note`](#edit_note) `replace`. The coordinates travel beside the text, in `lines`.

A `lines` selector is **clipped to the body** at both ends: a range that starts inside the frontmatter begins at the first body line, and one that runs past the end stops at the last line. The echoed `lines` shows the span actually returned. A partial overlap is clipped, not a miss; only a range that shares no line with the body is a miss (`LINES_OUT_OF_RANGE`, [below](#misses)). `[n, n]` reads one line.

#### `content` modes

`content` is one value for the whole call, next to `paths` — `{ paths: [...], content: "outline" }` — never inside an item (a `content` key inside an item fails the call with `INVALID_PARAMS`). `frontmatter`, `outline` and `full` apply to each item's selection exactly as they apply to a whole note; the selection of a bare path is its body. Frontmatter is returned in every mode:

| Mode          | Returns                                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `frontmatter` | `{ path, frontmatter }` — no body, no coordinates                                                                                        |
| `outline`     | `{ path, frontmatter, lines, preamble?, outline, collapsed? }` — the heading blocks of the selection, no body text                       |
| `preview`     | `{ path, frontmatter, content, truncated }` — bounded (~500-char) slice of the whole note's body; `truncated: true` when the body was cut |
| `full`        | `{ path, frontmatter, lines, content }` — the whole selection                                                                            |

- `lines` on the item is the **selection's span**. For a whole note it is the body span, `[first body line, last line]`, so the frontmatter ends on `lines[0] − 1`. A note with no body line (an empty file, or frontmatter only) carries no `lines`.
- A heading read (`{ path, heading }`) in `full` or `outline` also echoes the matched `heading` and its `level` next to `lines`.
- When the frontmatter holds YAML that does not parse, a whole-note `full` read returns `frontmatter: null` and the whole raw file as `content`, so its `lines` is `[1, last line]`. `outline`, and every selection, still treat the fence as frontmatter, so their `lines` start after it.
- `preamble: [start, end]` is the note's text before its first heading, intersected with the selection, and is present only when that part is non-blank. A heading read never has one.
- `preview` does not apply to a selection yet: it previews the whole note's body whatever an item selects, and the selector is not resolved.
- `frontmatter` still resolves an item's selector, so a selector that finds nothing is a miss in this mode too.

**Default when `content` is omitted:** a selector item returns its selection in `full`; a bare path returns `full` when the call has one item and `preview` otherwise. Every item counts, selector items included, so `["a.md", { path: "b.md", heading: "Notes" }]` previews `a.md`. An explicit `content` applies to every item in the call.

Re-read a previewed note with `content: 'full'`, or read the part you need, before citing or editing it.

Returns `{ results, count, errors }` where each item in `results` is either a success object (shape depends on `content` mode) or `{ path, error: { code, message } }` plus retry data (failure). `count === results.length` (total items, including failures); `errors` is the subset of those that failed. To get the successful-read count, subtract: `count - errors`.

#### The outline

```json
{
  "path": "projects/onboarding.md",
  "frontmatter": { "type": "project" },
  "lines": [4, 30],
  "preamble": [4, 6],
  "outline": [
    { "heading": "First 30 days", "level": 2, "lines": [7, 18] },
    { "heading": "Week 1", "level": 3, "lines": [11, 18] },
    { "heading": "Decisions", "level": 2, "lines": [19, 30] },
    { "heading": "Notes", "level": 3, "lines": [22, 25] },
    { "heading": "Notes[2]", "level": 3, "lines": [26, 30] }
  ]
}
```

- **Entries are flat, in source order.** `level` is the `#` count (1–6); nesting shows in `level` and in nested `lines`.
- **An entry's `lines` is its whole heading block:** from the heading line through the line before the next heading of the same or higher level, sub-headings included. "First 30 days" `[7, 18]` contains "Week 1" `[11, 18]`. A heading read of an entry returns exactly this span.
- **`heading` is the heading name** — the heading's text as written, with `[n]` on a repeat among siblings: `Notes[2]` is the second `Notes` directly under the same parent heading. A `Notes` under a different parent is not suffixed. Pass the name unchanged as `{ path, heading }`. It is the same string semantic `search_notes` `blocks[].heading` carries for that block.
- **Own text** — a heading's lines before its first sub-heading — runs from the entry's `lines[0]` to the next entry's `lines[0] − 1` when that next entry starts inside the entry's `lines`, and is the whole entry otherwise. Above, the own text of "First 30 days" is lines 7–10: read it with `{ path, lines: [7, 10] }`. "Week 1" has no sub-heading, so all of `[11, 18]` is its own text.
- **Only root-level ATX headings** (`#` … `######` at the start of a line) are heading blocks. Setext headings and headings inside lists or blockquotes are not listed and cannot be read by `heading`; their lines belong to the heading block around them (or to the preamble).
- **A note without headings** returns `outline: []`, with a `preamble` covering the body when it is non-blank.

**An outline of a selection** lists the heading blocks whose heading line lies inside the selection, each with its true span — never clipped to the selection. A heading read in `outline` mode therefore lists the selected heading itself first, then everything under it.

**Collapse.** An outline lists at most 100 entries. Past that, the deepest nesting level is dropped, again and again, until the outline fits, and the item carries `collapsed: true`. Nesting is by containment, not by `#` count: a `###` directly under a `#` is one level down. The shallowest level is never dropped, so a note with 150 top-level headings lists all 150. An entry whose sub-headings were dropped carries `hidden: n` — **n headings below it, at all depths, are not listed**:

```json
{
  "path": "logs/2026.md",
  "frontmatter": { "type": "resource" },
  "lines": [4, 1225],
  "outline": [
    { "heading": "Work log", "level": 1, "lines": [4, 1225] },
    { "heading": "2026-01", "level": 2, "lines": [6, 111], "hidden": 31 },
    { "heading": "2026-02", "level": 2, "lines": [112, 212], "hidden": 28 }
  ],
  "collapsed": true
}
```

(The example is cut after two months; the real outline carries one entry per month.) An outline that fits carries neither `hidden` nor `collapsed`.

Hidden headings are still readable by name. To list what an entry hides, read that entry's outline: `{ paths: [{ path: "logs/2026.md", heading: "2026-01" }], content: "outline" }`. The cap and the collapse count within the selection, so this lists the sub-headings the whole-note outline dropped.

#### Reading a heading block

`{ path, heading }` matches the heading name **exactly** first. Only when nothing matches exactly does it fall back to a looser comparison — case, extra whitespace, emphasis and code markup, wikilink and Markdown link brackets (the link text stays), and a leading `#` run are ignored — and the fallback is accepted only when it picks exactly one heading block. Case folding is Unicode-aware, so non-Latin names compare too. The heading's level is not part of the match, and a prefix never matches. Every heading block counts, including one a collapsed outline does not list.

With the outline above, `{ path: "projects/onboarding.md", heading: "decisions" }` reads `Decisions` and echoes `heading: "Decisions"`, `level: 2`, `lines: [19, 30]`. `Notes` reads lines 22–25 and `Notes[2]` lines 26–30: an exact match on `Notes` never reaches the second sibling.

#### Misses

A selector that finds nothing fails **its item only**; the other items are unaffected, and the item counts toward `errors`. A miss item carries `error: { code, message }` plus retry data under the names successful items use, and no `frontmatter`. Its message names the cause and the retry.

| Code                 | Cause                                                                           | Retry data                                                       | Retry with                            |
| -------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `HEADING_NOT_FOUND`  | no heading block has that name, exactly or by the fallback                      | body `lines` + the note's `outline` (collapsed as in `outline`) | a `heading` from the outline          |
| `AMBIGUOUS_MATCH`    | the name matches several heading blocks (say, the same name under two parents) | `matches: [{ heading, level, lines }]`                           | `{ path, lines }` of the one you want |
| `LINES_OUT_OF_RANGE` | the range shares no line with the body                                          | body `lines`                                                     | a range inside it                     |
| `NOT_FOUND`          | the note does not exist                                                         | —                                                                | —                                     |

A note with no body line (an empty file, or frontmatter only) carries no body `lines` on a miss, and every `lines` selector on it is `LINES_OUT_OF_RANGE`; for a frontmatter-only note the message points to `content: 'frontmatter'`. When the frontmatter fence holds YAML that does not parse, a miss in or around it points to a whole-note `content: 'full'` read instead, since that read returns the fence as text and a frontmatter read returns `null`. An unsafe path (one that escapes the vault) is a per-item `INVALID_ARGUMENT`, like a bare path.

The miss shape does not depend on `content`: in `frontmatter`, `outline` and `full` the selector is always resolved.

#### Argument faults

Some faults fail the **whole call**, before any note is read:

- `INVALID_PARAMS` (the input gate) — an empty or blank `heading` (a block without a heading is read with `lines`), a malformed `lines` (it must be two integers with `1 ≤ start ≤ end`), and a key an item does not take, such as `content`.
- `INVALID_ARGUMENT` — both `heading` and `lines` in one item.

Quoted numbers in `lines` (`["3", "9"]`) and a `paths` array sent as a JSON string are coerced before validation; see [`input-coercion.md`](../architecture/input-coercion.md).

#### From a search hit to a read

Every `search_notes` body evidence row with `lines` reads back as `{ path, lines: row.lines }` — a semantic `blocks[]` entry and a lexical body or heading match alike. Read several hits in one call, one item per hit; with `content` omitted each returns its selection in `full`.

```json
{
  "paths": [
    { "path": "projects/onboarding.md", "lines": [19, 30] },
    { "path": "logs/2026.md", "lines": [188, 188] }
  ]
}
```

- **`{ path, heading: row.heading }`** is an equal alternative only for a semantic block with a non-empty `heading`; it reads the same span.
- **A `---frontmatter---` block** is the frontmatter, which lies outside the body: its `lines` are `LINES_OUT_OF_RANGE`. Read it with `content: 'frontmatter'` on its path.
- **`heading: ""`** on a semantic block marks a paragraph inside a heading block, or the preamble — it does not name the heading block around it. Read it with `lines`; passing `""` as `heading` fails the whole call.
- **A lexical `heading`** is the text of the nearest heading before the match — a label. Nothing guarantees it names a heading block: it may be a setext heading, a heading inside a list, or one of several siblings with the same text, and then a bare `Notes` matches the first of `Notes` / `Notes[2]` exactly, with no error.
- **Check the echo.** A heading read echoes its `lines`. If the hit's `lines` fall outside them, the name picked another block: read the outline and pick by `lines`.
- **The heading block around a hit:** read the outline and take the deepest entry whose `lines` contain the hit's `lines`, then read it by `heading`.

#### Examples

Read a single note (defaults to `full`):

```json
{ "paths": "Projects/neuro-vault.md" }
```

Batch-read several notes (defaults to `preview` to keep the response bounded):

```json
{ "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md", "Archive/old-idea.md"] }
```

Each item comes back with frontmatter and a preview body. When `truncated: true`, re-read the individual note with `content: 'full'`, or read the part you need, before citing or editing it.

The outline only, to see how a long note is organised before reading it:

```json
{ "paths": "logs/2026.md", "content": "outline" }
```

One heading block, and the own text of another (each defaults to `full`):

```json
{
  "paths": [
    { "path": "projects/onboarding.md", "heading": "Decisions" },
    { "path": "projects/onboarding.md", "lines": [7, 10] }
  ]
}
```

Frontmatter only across a list of paths (`content: 'frontmatter'` whenever you need metadata across several notes):

```json
{ "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md"], "content": "frontmatter" }
```

Returns the parsed YAML frontmatter for each note without loading the note body — useful when you need metadata (status, tags, due dates) across many notes at once.

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
