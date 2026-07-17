# Reading & Modifying

> All operations on this page — reads and writes — go directly against the vault directory on disk. None of them require Obsidian to be installed or running.

Every write tool (`create_note`, `edit_note`, `set_property`, `remove_property`) writes directly to disk. If you have Obsidian open on the same vault, its own file watcher picks up the change on its usual cadence — there is no separate fast path through the app.

`read_notes` reads files directly from the vault directory, making it fast and available even when Obsidian is not running.

**Per-vault failures.** When a fan-out tool (`list_tags`, `list_properties`, `query_notes`, `get_vault_overview`, `search_notes`) is called in multi-vault mode without an explicit `vault:`, per-vault failures do not abort the whole call. Successful vaults still return their results in `results_by_vault`; the failing vault appears in a `failed_vaults` array with its error code, message, and details. `failed_vaults` is always present (empty array when nothing failed). See [docs/architecture/fan-out.md](../architecture/fan-out.md) for the full contract.

Most tools on this page accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`. `read_notes` accepts `paths` only (no wikilink resolution); if you only have a note name, resolve it to a path with [`search_notes`](./finding-notes.md) first.

## Notes

### `read_notes`

Read one or more notes directly from disk. Returns per-item results in input order; failed paths carry an error rather than aborting the whole call. Does not require Obsidian to be running.

```typescript
read_notes({
  paths: string | string[],                        // single path, or 1–50 vault-relative paths
  content?: 'full' | 'preview' | 'frontmatter',    // optional; default derived from path count
})
```

`paths` accepts either a single path string (single-note read) or an array of 1–50 paths (batch read). The result shape is identical in both cases. Duplicates are de-duplicated; results are returned in input order.

**`content` modes — frontmatter is always returned regardless of mode:**

| Mode          | Returns                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| `full`        | `{ path, frontmatter, content }` — complete body                                                                      |
| `preview`     | `{ path, frontmatter, content, truncated }` — bounded (~500-char) body slice; `truncated: true` when the body was cut |
| `frontmatter` | `{ path, frontmatter }` — no body                                                                                     |

**Default when `content` is omitted** is derived from the number of distinct requested paths: exactly one path → `full`; two or more paths → `preview`. An explicit `content` always overrides the count-based default.

Re-read a previewed note with `content: 'full'` before citing or editing it.

Returns `{ results, count, errors }` where each item in `results` is either a success object (shape depends on `content` mode) or `{ path, error: { code, message } }` (failure). `count === results.length` (total items, including failures); `errors` is the subset of those that failed. To get the successful-read count, subtract: `count - errors`.

**Example — read a single note (defaults to `full`):**

```json
{
  "paths": "Projects/neuro-vault.md"
}
```

**Example — batch-read multiple notes (defaults to `preview` to keep the response bounded):**

```json
{
  "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md", "Archive/old-idea.md"]
}
```

Each item comes back with frontmatter and a preview body. When `truncated: true`, re-read the individual note with `content: 'full'` before citing or editing it.

**Example — read frontmatter only across a list of paths (`content: 'frontmatter'` whenever you need metadata across several notes):**

```json
{
  "paths": ["Projects/neuro-vault.md", "Notes/embeddings.md"],
  "content": "frontmatter"
}
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

The same payload is available as the MCP resource `vault://overview`; clients that auto-load resources will pull it without an explicit tool call.
