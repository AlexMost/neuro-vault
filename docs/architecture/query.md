# Query Module

The piece of the operations module that powers the `query_notes` tool — a
MongoDB-style structured query layer over the vault's metadata.

## What it is

`src/modules/operations/query/` exports three things:

```typescript
function toNoteRecord(item: ReadNotesItemSuccess): NoteRecord;
function validateFilter(filter: unknown): void; // throws INVALID_FILTER
function runQueryNotes(input, reader: VaultReader): Promise<QueryNotesResult>;
```

`NoteRecord` is the shape the filter sees: `{ path, frontmatter, tags }`. Tags
are extracted from the `tags:` frontmatter field, coerced to a `string[]`, with
leading `#` stripped and blanks dropped.

`validateFilter` runs a recursive walk over the input filter and rejects any
`$`-prefixed key that is not on a small allow-list of operators (`$eq`, `$ne`,
`$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`,
`$nor`, `$not`). Especially important: `$where` and `$function` are banned.

`runQueryNotes` is the handler. It:

1. Validates input shape (`limit` cap, `path_prefix` shape, `sort` field/order).
2. Validates the filter against the operator allow-list.
3. Calls `VaultReader.scan({ pathPrefix })` to get paths.
4. Calls `VaultReader.readNotes({ paths, fields })`. `fields` is `['frontmatter']`
   by default and `['frontmatter', 'content']` only when `include_content: true`.
5. Drops per-item reader errors silently (`NOT_FOUND` is a `scan↔read` race;
   `READ_FAILED` warns once on stderr). Errors do not appear in `results` and do
   not affect `truncated`.
6. Maps successful items through `toNoteRecord` and runs `sift(filter)` against
   the records.
7. Optional `sort` — by `path` or any `frontmatter.<key>`. Missing values sort
   last.
8. Slices to `limit` (default 100, cap 1000) and computes `truncated` from the
   pre-slice match count.

## Why it exists separately from the reader

The reader is a thin fs adapter — it reads bytes and parses frontmatter, and
that's all it knows about. Tag normalisation, filter evaluation, projection,
and sorting are query-specific concerns. Putting them here keeps the reader
honest (it can be reused by tools that don't care about queries) and gives the
later Batch 2 migration (read-only `read_property` / `get_tag` / `list_tags` /
`list_properties` moving onto the same scan + record pipeline) a natural home.

## Why MongoDB-query syntax (sift) and not a custom AST

- LLM clients already know MongoDB-query syntax from training data — no need to
  teach a proprietary one.
- `sift` validates operator semantics and shapes. Our allow-list is a few lines
  on top.
- A future DQL-string parser (Dataview-style `tag = "ai" AND status = "active"`)
  emits MongoDB-JSON directly, so it plugs in without touching this module's
  contract.
- Fewer layers, fewer bugs.

## What it deliberately does not do

- It does not parse inline `#tags` from the body. Only frontmatter `tags:` is
  read. Body parsing needs a tokenizer aware of code-fences, wikilink anchors,
  and headings; separate ticket.
- It does not implement hierarchical tag matching. `"ai"` does not match
  `#ai/ml`. Agents pass `$in` / `$regex` explicitly until sugar lands.
- It does not auto-prefix `frontmatter.`. Filter authors write the full
  dotted path. Sugar later.
- It does not cache. `runQueryNotes` calls `reader.scan` + `reader.readNotes`
  on every invocation. Caching belongs in a future cached-reader implementation
  swapped in via DI; the query module does not change.
- It does not project frontmatter fields. The full parsed object is returned.
  Granular field-level projection is a future ticket; the coarse
  `include_content` toggle is in scope to avoid `query_notes` becoming an N+1
  source for body reads.

## What changes when a cached reader lands

Nothing in this module. `runQueryNotes` depends on the `VaultReader` interface
only; swapping `FsVaultReader` for a cached reader is a wiring change in
`createOperationsModule`. The contract — `scan` returns paths, `readNotes`
returns frontmatter / content — stays the same.
