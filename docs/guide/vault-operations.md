# Vault Operations

> CLI-routed operations (`create_note`, `read_daily`, properties, tags) require the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) on `PATH` and Obsidian running. `edit_note`, `read_notes`, and `query_notes` work directly against the filesystem and do **not** require Obsidian to be running.

Most write paths shell out to the `obsidian` CLI, so changes are picked up immediately by Smart Connections, sync, and any other plugin you have installed. The exception is `edit_note` (in-place replace and full-body rewrite), which writes directly to disk — Obsidian's file watcher then notifies plugins on its own cadence.

`read_notes` reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

**Per-vault failures.** When a fan-out tool (`list_tags`, `list_properties`, `query_notes`, `get_vault_overview`, `search_notes`) is called in multi-vault mode without an explicit `vault:`, per-vault failures do not abort the whole call. Successful vaults still return their results in `results_by_vault`; the failing vault appears in a `failed_vaults` array with its error code, message, and details. `failed_vaults` is always present (empty array when nothing failed). See [docs/architecture/fan-out.md](../architecture/fan-out.md) for the full contract.

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

Returns `{ results, count, errors }` where each item in `results` is either `{ path, frontmatter?, content? }` (success) or `{ path, error: { code, message } }` (failure). `count === results.length` (total items, including failures); `errors` is the subset of those that failed. To get the successful-read count, subtract: `count - errors`.

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
  frontmatter?: Record<string, unknown>,
  overwrite?: boolean,
})
```

Paths without an extension are treated as `.md` notes.

Pass `frontmatter` as a structured object rather than hand-writing a `---` block inside `content`; it is serialized to YAML and prepended to the note, with `[[wikilinks]]` quoted, dates formatted, and tag lists rendered as blocks. If `content` also begins with its own `---` block, the two are merged key-by-key: keys from `content` are kept, the `frontmatter` parameter's keys are layered on top, and the parameter wins on any key collision (the body is kept). An empty `frontmatter` object is treated as if it were omitted.

Before composing `content`, sample 1–2 similar notes from the vault to mimic existing conventions — typically `search_notes` for the topic, then `read_notes` on the closest match to inspect its frontmatter shape, tag values, heading layout, and folder placement. Match those conventions instead of inventing new ones. Be especially careful with the `type` frontmatter field: vaults tend to use a small closed set; pick from what other notes use rather than coining a new value.

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

## Structured queries

### `query_notes`

Run a multi-criteria query against the vault using a MongoDB-style filter — replaces N+1 patterns like "list tags → read each note's property → filter in head" with one call. Also serves as the canonical way to list notes carrying a specific tag (`{ filter: { tags: '<name>' } }`).

```typescript
query_notes({
  filter: object,              // MongoDB-style query (see below)
  path_prefix?: string | string[],   // restrict scan to a subtree (or several), e.g. "Projects/" or ["Tasks/", "Reflections/"]
  exclude_path_prefix?: string | string[], // drop notes whose path starts with any listed prefix (e.g. ["Daily/", "Archive/"])
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

Returns `{ ok: true }`. Existing properties are overwritten. Paths without an extension are treated as `.md` notes.

### `read_property`

Read a single frontmatter property value. Use `read_notes` with `fields: ['frontmatter']` if you need the full frontmatter or accurate type information across one or more notes.

```typescript
read_property({
  name?: string,
  path?: string,
  key: string,
})
```

Returns `{ value }`. Paths without an extension are treated as `.md` notes.

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

### `list_properties`

List all frontmatter properties used across the vault, sorted by occurrence count desc. Useful for understanding the vault's metadata ontology before calling `set_property`.

Returns `[{ name, count }, ...]`.

### `list_tags`

List all tags used across the vault, sorted by occurrence count desc.

Returns `[{ name, count }, ...]`.

To list the notes that carry a specific tag, use [`query_notes`](#query_notes) with `{ filter: { tags: '<name>' } }`.

### `get_vault_overview`

Get a snapshot of your vault's structure in one call. Returns top-level folder counts, top tags, frontmatter properties, the total note count, and the top 10 notes by inbound wikilinks. This is the recommended first call for an agent orienting itself in a vault it has not seen before — one call replaces the older `list_tags + list_properties + exploratory query_notes` ritual.

The same payload is available as the MCP resource `vault://overview`; clients that auto-load resources will pull it without an explicit tool call.

## Wikilink graph

### `get_note_links`

Return the wikilink adjacency for a single note: the full incoming and outgoing edge lists derived from the vault-wide wikilink graph (`[[X]]` and `![[X]]` embeds, in body or frontmatter).

```typescript
get_note_links({
  path: string, // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
});
```

Paths without an extension are treated as `.md` notes.

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
