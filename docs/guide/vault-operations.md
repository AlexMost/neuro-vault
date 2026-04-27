# Vault Operations

> Requires the [Obsidian CLI](https://github.com/AlexMost/obsidian-cli) on `PATH` and Obsidian running. Pass `--no-operations` to disable.

Read and write notes through Obsidian itself — the operations module shells out to the `obsidian` CLI, so changes are picked up by Smart Connections, sync, and any other plugin you have installed. No bypass of Obsidian's own state.

All vault-operations tools accept `name` (wikilink-style) **or** `path` (vault-relative POSIX) for note identification — exactly one of the two. Both or neither yields `INVALID_ARGUMENT`.

## Notes

### `read_note`

Read a note's contents.

```typescript
read_note({
  name?: string,    // wikilink-style: "My Note"
  path?: string,    // vault-relative: "Folder/My Note.md"
})
```

Returns `{ path, content }`.

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

Read a single frontmatter property value. Use `read_note` if you need the full frontmatter or accurate type information.

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

### `get_tag`

Get count and (optionally) the file list for a single tag. Pass `include_files: false` for popular tags where the file list would be large.

```typescript
get_tag({
  tag: string,             // with or without leading "#"
  include_files?: boolean, // default true
})
```

Returns `{ name, count, files? }` — `name` is the stripped tag string (the same value you passed as `tag` input, minus any leading `#`).
