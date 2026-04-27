---
status: accepted
date: 2026-04-27
---

# query_notes — structured queries over the vault

## Goal

Add one MCP tool, `query_notes`, that lets an LLM client run multi-criteria queries against the vault's metadata (frontmatter + tags) without making N+1 calls. The agent currently has to combine `get_tag` → `read_property × N` → in-head filtering for questions like "active projects with #ai" or "todo tasks in active projects": ~50 tool calls and ~5k tokens for what should be one call and ~100 tokens.

`query_notes` is also the foundation for later absorbing the read-only Batch 2 tools (`read_property`, `get_tag`, `list_tags`, `list_properties`) onto the same pipeline — and for adding a DQL-string parser on top (DQL → MongoDB-JSON → sift) without changing this tool's contract.

## Scope

### One tool

| Tool          | Signature                                                   | Returns                                                            |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `query_notes` | `{ filter, path_prefix?, sort?, limit?, include_content? }` | `{ results: [{ path, frontmatter, content? }], count, truncated }` |

### Filter format — direct MongoDB-query syntax (sift)

No wrapping AST, no proprietary operators. `sift.js` evaluates the filter against `NoteRecord[]`. We add a tiny whitelist on the way in to ban dangerous operators.

**`NoteRecord` shape — the contract the filter sees:**

```ts
{
  path: string,           // "Projects/foo.md"
  frontmatter: object,    // parsed YAML, full passthrough from FsVaultReader
  tags: string[],         // normalised, no leading "#", frontmatter-only in MVP
}
```

`mtime` is out of scope (see Out of scope). Without it, sorting by `"modified"` is also dropped.

**Allowed operators (whitelisted subset of sift):** `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`. Anything else starting with `$` → `INVALID_FILTER`. Whitelist is recursive (operators inside `$and`/`$or` are checked too). Especially important: ban `$where` (`eval`) and `$function`.

**Tag matching:** sift-default exact-string against the `tags: string[]` array. `"ai"` does NOT match `#ai/ml`. Hierarchical sugar is a separate future task — for now agents pass `{ "tags": { "$in": ["ai", "ai/ml"] } }` or `{ "tags": { "$regex": "^ai(/|$)" } }` explicitly.

**Dates:** ISO-string lexicographic comparison (`YYYY-MM-DD`).

**Examples:**

```jsonc
// active todo tasks
{ "frontmatter.status": "todo", "frontmatter.project_status": "active" }

// many statuses
{ "frontmatter.status": { "$in": ["active", "wip"] } }

// AND/OR composition
{
  "$and": [
    { "tags": "ai" },
    { "$or": [
      { "frontmatter.status": "active" },
      { "frontmatter.status": "wip" }
    ]},
    { "frontmatter.created": { "$gte": "2026-01-01" } }
  ]
}

// exists check
{ "frontmatter.deadline": { "$exists": true } }
```

### Optional parameters

- **`path_prefix`** — restrict scan to a subtree (`"Projects/"`, `"Areas/finance/"`). Vault-relative POSIX, no leading slash, no `..`. Trailing slash tolerated. `"."` is forbidden — pass nothing instead.
- **`sort`** — `{ field, order }`. `field` may be `"path"` (reserved) or any frontmatter key written as `"frontmatter.<key>"`. `order` — `"asc"` | `"desc"`. Default: scan order. Sorting by `"modified"` is out of scope (no `mtime` in MVP).
- **`limit`** — integer, default `100`, hard cap `1000`. Stops an LLM agent from accidentally pulling the whole vault.
- **`include_content`** — boolean, default `false`. When `true`, every result also carries `content` (body without frontmatter block). Saves the N+1 pattern `query_notes` → `read_notes × N` when the agent knows up-front it needs bodies.

### Output shape

```ts
{
  results: Array<{ path: string; frontmatter: object; content?: string }>;
  count: number; // === results.length
  truncated: boolean; // true ⇔ matched > limit
}
```

`count` is always `results.length` — what we returned, not what matched. `truncated` is the signal: agent should narrow filter or raise `limit` (within hard cap). If `results.length === limit` and `truncated === false`, that's the exact total.

## Architecture

Minimal: one new method on the existing reader, one new query module, three new dependencies.

1. **`VaultReader.scan({ pathPrefix? })`** — new method on the existing `VaultReader` interface (`src/modules/operations/vault-reader.ts`). Thin wrapper over `fast-glob` with `pathPrefix` as a glob prefix. Returns `Promise<string[]>` of vault-relative paths. No cache — full rescan on each call. A cached implementation is a future, separate `CachedVaultReader` (see `docs/architecture/vault-reader.md`, "What changes for v2").
2. **`toNoteRecord(item: ReadNotesItemSuccess) → NoteRecord`** — pure function in `src/modules/operations/query/`. Reads `readNotes` output, returns sift-ready record. Tag normalisation: **frontmatter `tags:` field only** (array or scalar→array, leading `#` stripped, blanks dropped). No inline-`#tag` parsing of the body in MVP — that needs a tokenizer that ignores code-fences, wikilink anchors, headings; separate ticket.
3. **`query_notes` tool** — thin handler (~40 lines) in the operations module:
   ```
   validate input
   → reader.scan({ pathPrefix })
   → reader.readNotes({ paths, fields: ['frontmatter', ...content] })
   → drop per-item errors silently (NOT_FOUND = scan↔read race; READ_FAILED = warn-log; neither surfaces, neither affects truncated)
   → records = items.map(toNoteRecord)
   → matched = records.filter(sift(filter))
   → sort if requested
   → truncated = matched.length > limit
   → return { results: matched.slice(0, limit), count, truncated }
   ```
4. **`sift.js`** (npm) executes the filter against `NoteRecord[]`. Tiny whitelist on the way in is a few lines, not a full validator.

### Why no proprietary AST / validator / translator

- LLMs already know MongoDB-query syntax from pretraining. Don't teach them another one.
- sift validates operators itself; whitelist is a few lines.
- Fewer layers = fewer bugs.
- Future DQL parser emits MongoDB-JSON directly — same integration point.

### Why tag normalisation lives in the query module, not the reader

The reader is a thin fs adapter (no projection, no normalisation — see `docs/architecture/vault-reader.md`). `ReadNotesItemSuccess → NoteRecord` is query-specific, so it lives in `src/modules/operations/query/`. When Batch 2 read-only tools migrate to this pipeline (separate ticket), they reuse `toNoteRecord` as a shared utility while the reader keeps doing one job — reading files from disk.

### Repo organisation

One package. One `package.json`. Existing `src/modules/` structure:

```
src/
├── server.ts                            # MCP server, tool registration
├── lib/                                  # cross-cutting helpers
└── modules/
    ├── operations/
    │   ├── vault-reader.ts               # EXTENDED — adds scan()
    │   ├── query/                        # NEW — toNoteRecord, whitelist, query_notes handler
    │   │   ├── index.ts                  # public API
    │   │   ├── note-record.ts
    │   │   ├── whitelist.ts
    │   │   └── query-notes.ts
    │   └── ...                           # existing CRUD handlers
    └── semantic/                         # embeddings (existing)
```

Cross-module imports go through `index.ts` only (already enforced).

## Behaviour

- **Tag matching** — exact-string (sift-default) against the `tags: string[]` array. No hierarchy in MVP. Tags in `NoteRecord.tags` are stored without `#` — filters write the same.
- **Property normalisation in `toNoteRecord`** — frontmatter is passed through as parsed (yaml lib). Lists stay arrays, scalars stay primitives. Missing key / `null` → JS `undefined` / `null`; sift `$exists: false` works against both.
- **Missing property semantics** — standard sift: any comparison against a missing field is `false`. Only `$exists: false` is true.
- **Empty result** — `{ results: [], count: 0, truncated: false }`, never an error.
- **Truncation signal** — `count === results.length`. `truncated === true` ⇔ matched count exceeded `limit`. If `results.length === limit` and `truncated === false`, that's exactly the matched count.

## Error codes

- `INVALID_FILTER` — sift threw on syntax, or whitelist rejected an operator. Message names the offending operator/path.
- `INVALID_PARAMS` — bad `path_prefix` (absolute, contains `..`), `limit` outside `[1, 1000]`, unknown `sort.order`, or unsupported `sort.field`.
- `PATH_NOT_FOUND` — `path_prefix` points at a non-existent directory. Empty subtree (no `.md` files) is NOT an error — returns `{ results: [], count: 0, truncated: false }`.

(All three codes go through `ToolHandlerError` to keep the structured-content envelope consistent with other operations tools.)

## Tests

### Unit — `VaultReader.scan()`

- Scan whole vault → all `.md` paths, vault-relative, POSIX
- Scan with `pathPrefix: "Projects"` and `"Projects/"` produce the same result
- Non-existent prefix → `PATH_NOT_FOUND`
- Empty subtree (exists, no `.md`) → `[]`, not an error
- Absolute path or `..` in `pathPrefix` → `INVALID_PARAMS`

### Unit — `toNoteRecord`

- Frontmatter primitives (string/number/boolean/list/date) pass through untouched
- Tag normalisation: array, scalar→array, missing → `[]`, leading `#` stripped, empty strings dropped
- Empty frontmatter → `{ tags: [] }`
- Per-item reader errors do NOT reach `toNoteRecord` — they are filtered out earlier

### Unit — operator whitelist

- Allowed operators pass
- `$where` / `$function` / unknown `$X` → `INVALID_FILTER`
- Recursive — operators inside `$and`/`$or` are checked
- Plain field names (no `$`) are not flagged

### Unit — handler layer

- Invalid `path_prefix` / `limit` / `sort.order` → `INVALID_PARAMS`
- Sort by `path`, by `frontmatter.<key>`; `asc` / `desc`
- `limit` cap respected; `truncated` correct in both directions
- `include_content: true` returns `content`; default returns no `content`
- Per-item reader errors (`NOT_FOUND`/`READ_FAILED`) are silently dropped — never appear in `results`, do not affect `truncated`
- Empty result is `{ results: [], count: 0, truncated: false }`, not an error

### Integration — mini fixture vault (~20 files)

End-to-end on a real-on-disk fixture. Cases:

- Simple property filter
- Tag + property combination
- `$or` over multiple property variants
- Date `$gte`
- `$exists` true/false
- Deep `$and`/`$or` nesting
- Empty result

### Manual smoke

Run against the real vault: "active projects with #mcp", "todo tasks created this week", "reflections about Obsidian". Eyeball.

## Out of scope (MVP)

- **Hierarchical tag matching** (`"ai"` → `#ai/*`) — sugar later; for now agents write `$in` / `$regex` explicitly.
- **Auto-prefix `frontmatter.`** — MVP requires the full path `"frontmatter.status"`. Sugar later.
- **Body / content matching** — query reads metadata only. Content search is a separate tool (`search_text`, Batch 3).
- **Inline Dataview-style fields** (`key:: value` in body). Frontmatter only.
- **Index caching + filesystem watcher** — separate optimisation ticket.
- **`select` projection on frontmatter fields** — full frontmatter is always returned. Granular field-level projection is a future ticket; the coarse `include_content` toggle is in scope because without it `query_notes` itself becomes the N+1 source when bodies are needed.
- **DQL-string parser** — separate next ticket.
- **Aggregations** (group_by, count, sum) — separate next ticket.
- **Backlinks / outgoing links** as predicates — needs a separate index, separate ticket.
- **`mtime` in `NoteRecord` + sort by `"modified"`** — out of scope; ship together when an explicit use case appears.
- **Inline-`#tag` parsing of body** — out of scope; needs a tokenizer that ignores code-fences, wikilink anchors, headings.

## Future steps (not in this ticket)

1. Optional ergonomic preprocessor over `filter` (two sugar rules):
   - Hierarchical tags: `{ tags: "ai" }` → `{ tags: { $in: ["ai", { $regex: "^ai/" }] } }`
   - Auto-prefix: top-level non-whitelisted, non-`$` key → prepended with `frontmatter.`
   - Plugged in before sift; old full queries keep working.
2. Migrate `read_property` / `get_tag` / `list_tags` / `list_properties` (Batch 2) onto `VaultReader.scan() + toNoteRecord`. Drops the runtime dep on Obsidian for read-only ops.
3. Cached `VaultReader` (likely the future `VaultIndex` from the architecture doc) as a second implementation of the same interface — full scan + parse on startup, incremental update via `chokidar`. `query_notes` does not change; only the reader backend (DI) does.
4. DQL-string parser as syntactic sugar (`tag = "ai" AND status in ["active","wip"]` → MongoDB-JSON). Either lift Dataview's parser (`blacksmithgu/obsidian-dataview`, `src/expression/parse.ts`, MIT) or write a thin one for the needed subset.
5. Aggregations (group_by + count/sum) as post-processing over query results in the tool layer (no sift change).

## Definition of Done

- [ ] `query_notes` tool works through the neuro-vault MCP server
- [ ] `VaultReader.scan({ pathPrefix? })` added to interface, implemented in `FsVaultReader`, unit-tested
- [ ] `toNoteRecord` helper in `src/modules/operations/query/`, unit-tested
- [ ] Operator whitelist implemented and covered
- [ ] `sift`, `fast-glob` added as dependencies
- [ ] `include_content` toggle works, defaults to `false`
- [ ] `truncated` field semantically correct
- [ ] `tools/list` description covers `NoteRecord` shape, allowed operators, `include_content`, `truncated`
- [ ] Unit + integration green
- [ ] Manual smoke pass on real vault
- [ ] New version published to npm
- [ ] Master task `Build Vault Operations MCP Tools` updated (batch → done)

## Connections

- Master task: `Build Vault Operations MCP Tools`
- Adjacent: `Add properties and tags tools to neuro-vault` (Batch 2 read-only tools that will migrate to this pipeline later)
- Project: neuro-vault
