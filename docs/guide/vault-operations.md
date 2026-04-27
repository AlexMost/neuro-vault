# Vault Operations

> Write operations (`create_note`, `edit_note`, daily notes, properties, tags) require the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) on `PATH` and Obsidian running. Pass `--no-operations` to disable all operations tools. `read_notes` and `query_notes` read directly from disk and do **not** require Obsidian to be running.

Read and write notes through Obsidian itself — the operations module shells out to the `obsidian` CLI, so changes are picked up by Smart Connections, sync, and any other plugin you have installed. No bypass of Obsidian's own state.

`read_notes` is the one exception: it reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

Most vault-operations tools accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`. `read_notes` accepts `paths` only (no wikilink resolution); if you only have a note name, resolve it to a path with `search_notes` first.

## Notes

### `read_notes`

Batch-read 1–50 notes directly from disk. Returns per-item results in input order; failed paths carry an error rather than aborting the whole call. Does not require Obsidian to be running.

```typescript
read_notes({
  paths: string[],                              // 1–50 vault-relative paths
  fields?: ('frontmatter' | 'content')[],       // default: both
})
```

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

Add content to an existing note.

```typescript
edit_note({
  name?: string,
  path?: string,
  content: string,
  position: 'append' | 'prepend',
})
```

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
}
```

Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Reference tags via the top-level `tags` array (sift exact-match against array elements).

**Supported operators:** `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`. Anything else is rejected as `INVALID_FILTER`.

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

**Result shape:** `{ results: [{ path, frontmatter, content? }], count, truncated }`. `count === results.length` (what we returned), and `truncated === true` ⇔ matched count exceeded `limit`. When `truncated` is true, narrow the filter or raise `limit` (capped at 1000).

`include_content: true` returns the body alongside metadata — saves a follow-up `read_notes` call when you know up-front that bodies are needed, but grows the response significantly. Default off.

## Daily notes

### `read_daily`

Read today's daily note. Returns `{ path, content }`.

### `append_daily`

Append content to today's daily note.

```typescript
append_daily({ content: string });
```

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
