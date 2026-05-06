# Vault Operations

> CLI-routed operations (`create_note`, `read_daily`, properties, tags) require the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) on `PATH` and Obsidian running. `edit_note`, `read_notes`, and `query_notes` work directly against the filesystem and do **not** require Obsidian to be running. Pass `--no-operations` to disable all operations tools.

Most write paths shell out to the `obsidian` CLI, so changes are picked up immediately by Smart Connections, sync, and any other plugin you have installed. The exception is `edit_note` (in-place replace and full-body rewrite), which writes directly to disk — Obsidian's file watcher then notifies plugins on its own cadence.

`read_notes` reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

Most vault-operations tools accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`. `read_notes` accepts `paths` only (no wikilink resolution); if you only have a note name, resolve it to a path with `search_notes` first.

## Notes

### `read_notes`

Read one or more notes directly from disk. Returns per-item results in input order; failed paths carry an error rather than aborting the whole call. Does not require Obsidian to be running.

```typescript
read_notes({
  paths: string | string[],                     // single path, or 1–50 vault-relative paths
  fields?: ('frontmatter' | 'content')[],       // default: both
})
```

`paths` accepts either a single path string (single-note read) or an array of 1–50 paths (batch read). The result shape is identical in both cases.

Returns `{ results, count, errors }` where each item in `results` is either `{ path, frontmatter?, content? }` (success) or `{ path, error: { code, message } }` (failure). `count` is the number of successfully read notes; `errors` is the count of failed items.

**Example — read multiple notes, all fields (default):**

```json
{
  "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md", "Archive/old-idea.md"]
}
```

**Example — read frontmatter only across a list of paths (replaces N `read_property` calls when you need several keys):**

```json
{
  "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md"],
  "fields": ["frontmatter"]
}
```

`fields: ['frontmatter']` returns the parsed YAML frontmatter for each note without loading the note body — useful when you need metadata (status, tags, due dates) across many notes at once.

### `create_note`

Create a new note. `overwrite: true` is destructive — the AI assistant will ask before passing it.

```typescript
create_note({
  name?: string,
  path?: string,
  content?: string,
  template?: string,
  overwrite?: boolean,
})
```

### `edit_note`

Edit an existing note. `position` selects the operation:

- `append` — add `content` at the end of the body (via Obsidian CLI).
- `prepend` — add `content` at the start of the body (via Obsidian CLI).
- `replace` — exact-string find/replace inside the body (direct filesystem write). Requires `find`. If `find` matches more than once, the call fails with `AMBIGUOUS_MATCH` unless `replace_all: true`. Frontmatter is never touched.
- `replace_full` — overwrite the entire body with `content` (direct filesystem write). Frontmatter is preserved byte-for-byte.

```typescript
edit_note({
  name?: string,
  path?: string,
  content: string,
  position: 'append' | 'prepend' | 'replace' | 'replace_full',
  // when position === 'replace':
  find?: string,
  replace_all?: boolean, // default false
})
```

Errors:

- `INVALID_ARGUMENT` — empty `find`, both `name` and `path`, neither given.
- `NOT_FOUND` — note path missing, wikilink unresolved, or `find` text absent in body.
- `AMBIGUOUS_MATCH` — multiple `find` matches without `replace_all`, or a `name` resolves to multiple paths. `details.matches` carries 1-based body line numbers (for find ambiguity) or candidate paths (for name ambiguity).

## Structured queries

### `query_notes`

Run a multi-criteria query against the vault using a MongoDB-style filter — replaces N+1 patterns like "list tags → read each note's property → filter in head" with one call. Also serves as the canonical way to list notes carrying a specific tag (`{ filter: { tags: '<name>' } }`).

```typescript
query_notes({
  filter: object,              // MongoDB-style query (see below)
  path_prefix?: string,        // restrict scan to a subtree, e.g. "Projects/"
  sort?: { field: string, order: 'asc' | 'desc' },
  limit?: number,              // default 100, max 1000
  include_content?: boolean,   // default false
})
```

The filter is evaluated against a `NoteRecord` shape:

```ts
{
  path: string,           // "Projects/foo.md"
  frontmatter: object,    // parsed YAML, full passthrough
  tags: string[],         // normalized, no leading "#", from frontmatter `tags:`
  backlink_count: number, // total inbound wikilinks + embeds across the vault
}
```

Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Reference tags via the top-level `tags` array (sift exact-match against array elements). `backlink_count` is a top-level scalar — filterable (`{ backlink_count: { $gte: 5 } }`), sortable (`sort: { field: 'backlink_count', order: 'desc' }`), and always present on each result item.

**Supported operators:** `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$options`, `$and`, `$or`, `$nor`, `$not`. Anything else is rejected as `INVALID_FILTER`.

**`$regex` is case-insensitive by default.** `{ tags: { $regex: '^ai' } }` matches `#AI`, `#ai`, and `#Ai`. To opt out, pass `$options` explicitly — `{ $regex: '^ai', $options: '' }` for case-sensitive, `{ $regex: '^ai', $options: 'm' }` for multiline-only, `{ $regex: '^ai', $options: 'mi' }` for both.

**Examples:**

```json
// active todo tasks in active projects
{ "frontmatter.status": "todo", "frontmatter.project_status": "active" }
```

```json
// notes tagged #ai with status active or wip, created this year
{
  "$and": [
    { "tags": "ai" },
    { "$or": [{ "frontmatter.status": "active" }, { "frontmatter.status": "wip" }] },
    { "frontmatter.created": { "$gte": "2026-01-01" } }
  ]
}
```

```json
// notes that have a deadline set
{ "frontmatter.deadline": { "$exists": true } }
```

**Tag matching is exact (sift default):** `"ai"` does NOT match `#ai/ml`. To match a hierarchy, write `{ "tags": { "$in": ["ai", "ai/ml"] } }` or `{ "tags": { "$regex": "^ai(/|$)" } }` explicitly.

**Result shape:** `{ results: [{ path, frontmatter, backlink_count, content? }], count, truncated }`. `count === results.length` (what we returned), and `truncated === true` ⇔ matched count exceeded `limit`. When `truncated` is true, narrow the filter or raise `limit` (capped at 1000).

`include_content: true` returns the body alongside metadata — saves a follow-up `read_notes` call when you know up-front that bodies are needed, but grows the response significantly. Default off.

## Daily notes

### `read_daily`

Read today's daily note. Returns `{ path, frontmatter, content }`. The path is computed from the daily-notes plugin config; if the note does not yet exist, the result still carries the canonical path so callers can compose with `create_note`.

### Adding to today's daily note

There is no dedicated `append_daily` tool — compose:

1. `read_daily()` → `{ path, content }` (or `{ path, content: '' }` if the note is empty / missing).
2. If the note exists, call `edit_note({ position: 'replace_full', path, content: existingBody + newContent })`.
3. If the note does not exist, call `create_note({ path, content: newContent })`.

The trade-off vs the old `append_daily` is one extra read per write. In an agentic workflow this is invisible — the assistant typically reads daily-note context before writing anyway.

## Properties & Tags

Inspect and modify frontmatter without paying the token cost of reading whole notes. Properties and tags are the metadata an LLM agent checks dozens of times per session — _"what's the `status` on Quarterly review?"_, _"mark this task done"_, _"how many notes tagged #mcp?"_. Short request, precise answer, no full-note reads.

### `set_property`

Set a frontmatter property on a note. The YAML type is inferred from the JS value (`string` → text, `number` → number, `boolean` → checkbox, `Array` → list). For `date` / `datetime` pass `type` explicitly. List items must not contain commas (obsidian-cli limitation).

```typescript
set_property({
  name?: string,
  path?: string,
  key: string,             // property key, e.g. "status"
  value: string | number | boolean | string[] | number[],
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime',
})
```

Returns `{ ok: true }`. Existing properties are overwritten.

### `read_property`

Read a single frontmatter property value. Use `read_notes` with `fields: ['frontmatter']` if you need the full frontmatter or accurate type information across one or more notes.

```typescript
read_property({
  name?: string,
  path?: string,
  key: string,
})
```

Returns `{ value }`.

### `remove_property`

Remove a frontmatter property. Idempotent — calling it on an absent property succeeds.

```typescript
remove_property({
  name?: string,
  path?: string,
  key: string,
})
```

Returns `{ ok: true }`.

### `list_properties`

List all frontmatter properties used across the vault, sorted by occurrence count desc. Useful for understanding the vault's metadata ontology before calling `set_property`.

Returns `[{ name, count }, ...]`.

### `list_tags`

List all tags used across the vault, sorted by occurrence count desc.

Returns `[{ name, count }, ...]`.

To list the notes that carry a specific tag, use [`query_notes`](#query_notes) with `{ filter: { tags: '<name>' } }`.

## Wikilink graph

### `get_note_links`

Return the wikilink adjacency for a single note: the full incoming and outgoing edge lists derived from the vault-wide wikilink graph (`[[X]]` and `![[X]]` embeds, in body or frontmatter).

```typescript
get_note_links({
  path: string, // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
});
```

Returns:

```typescript
{
  incoming: { source: string }[],
  outgoing: {
    target: string,            // raw wikilink text (no display alias, no section anchor)
    resolved: boolean,         // false ⇔ no note exists yet for this name
    path?: string,             // vault path of the resolved target (only when resolved)
  }[],
}
```

- **Embeds count as wikilinks.** `![[X]]` produces an outgoing edge to `X`, exactly like `[[X]]`.
- **Unresolved targets are kept** (`resolved: false`) — useful when surfacing concepts the user has anchored but not yet written.
- **Self-links are dropped** — a note linking to itself does not appear in its own `incoming` or `outgoing`.
- **Backed by an in-memory index** that rebuilds lazily on query when older than 3 minutes; the first call after a stale window pays the rebuild cost. No watchers, no background timers.
- Reads directly from disk; does not require Obsidian to be running.

Use this **after** `search_notes` or `query_notes` finds a starting note, to traverse the graph around it. For ranking by inbound popularity rather than walking edges, see `backlink_count` on `query_notes` and `search_notes` results.
