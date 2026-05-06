# Add structural pre-filter to `search_notes`

Date: 2026-05-06
Status: Approved (awaits implementation)
Source: `Tasks/Add structural pre-filter to search_notes.md` (vault, 2026-05-01)

## Goal

Allow `search_notes` to accept an optional structural filter that narrows the candidate set **before** semantic ranking. Today the choice is binary: either semantic across the whole vault (with the LLM doing a manual post-filter) or `query_notes` without semantic. On niche / domain-scoped queries this hurts precision badly — narrative-heavy clusters in embedding space dominate the top-K and push the actually-relevant notes out.

A pre-filter restores precision without sacrificing semantic ranking.

## Scope

Add a single new optional parameter to `search_notes`:

```ts
filter?: {
  path_prefix?: string;                  // POSIX prefix, same shape as query_notes
  tags?: string[];                       // notes containing ANY of these tags (OR within array)
  frontmatter?: Record<string, unknown>; // sift filter, AND-composed with the above
}
```

**Composition semantics.** A note is included iff:
`(matches path_prefix) AND (matches tags) AND (matches frontmatter) AND (similarity ≥ threshold)`.

**`tags`.** Collected from frontmatter `tags:` exactly as the query module's `toNoteRecord` does — coerced to `string[]`, leading `#` stripped, blanks dropped. Match is `intersection(noteTags, filter.tags) ≠ ∅`.

**`frontmatter`.** Passes through the same `validateFilter` as `query_notes` (operator allow-list: `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`; `$where` / `$function` banned). Matched via `sift` against the full frontmatter object. **No auto-prefix** — the user writes top-level keys directly (e.g. `{ status: "active", priority: { $gte: 3 } }`), matching `query_notes` behaviour.

## Out of scope

- OR-composition of filter and semantic ("either in this scope OR top semantic"). Separate task.
- Boost / weight based on filter match (ElasticSearch `function_score` style).
- Filter on `backlink_count` — no clear use-case yet.
- Negation filters (`exclude_path_prefix`).

## Architecture

### Integration point

The filter is applied **in the `search_notes` tool handler**, by narrowing the `sources: Map<string, SmartSource>` before it reaches `executeRetrieval` / `executeMultiRetrieval`. **`retrieval-policy.ts` is not modified.** Expansion, block search, multi-query merge all already operate on the `sources` Map passed in from above, so they automatically inherit the filter.

### Flow

```
search_notes input
  │
  ├─► (filter present?)
  │        │ no  → use full sources Map (current behaviour, untouched)
  │        │
  │        │ yes
  │        ▼
  │   listMatchingPaths(filter) ──► Set<allowedPath>
  │        │
  │        ├─ empty? → return { results: [], blockResults?: [], truncated?: false }
  │        │           without invoking embed / searchEngine
  │        │
  │        ▼
  │   narrow sources: new Map([...sources].filter(([p]) => allowed.has(p)))
  │
  ▼
executeRetrieval / executeMultiRetrieval (unchanged)
  │
  ▼
post-filter: pathExists + backlink_count enrichment (unchanged)
```

### New helper: `listMatchingPaths`

```ts
type NoteFilter = {
  path_prefix?: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
};

type ListMatchingPaths = (filter: NoteFilter) => Promise<Set<string>>;
```

Implementation lives in the operations module (next to `runQueryNotes`) and is exported for cross-module wiring. It:

1. **Path_prefix-only fast-path.** If only `path_prefix` is set (no `tags`, no `frontmatter`), call `vaultReader.scan({ pathPrefix })` and return the path set directly. Frontmatter is never read — for "scope to a folder" queries this is essentially free.
2. **Otherwise.** Call existing `runQueryNotes` with the equivalent filter (`tags` translates to `{ tags: { $in: [...] } }` internally; `frontmatter` keys merge in via `$and`), `limit: large`, `sort: undefined` (so we get every match — ordering does not matter; we only need the set). Return `new Set(result.results.map(r => r.path))`.

Per-item read errors during scan stay silent, mirroring `runQueryNotes` (`NOT_FOUND` is a scan↔read race; `READ_FAILED` warns once on stderr). A global scan failure becomes `DEPENDENCY_ERROR` via existing `wrapDependencyError`.

### Cross-module DI

Semantic module must NOT import operations directly. `listMatchingPaths` is added to `SearchNotesDeps` and to `createSemanticModule`'s public dependencies. Wiring happens at the composition root (`src/server.ts`): create operations module → grab its `listMatchingPaths` → pass into `createSemanticModule`. One line of plumbing.

This keeps semantic independently testable (stub `listMatchingPaths`) and lets operations evolve internally without breaking semantic.

### Invariants preserved

- Threshold fallback (down to 0.3 when zero results) operates **within** the allowed set.
- Multi-query merge happens within the allowed set — `sources` is already narrowed before `executeMultiRetrieval` runs.
- Expansion (deep mode) draws only from the allowed set — same reason.
- Block search (deep & quick) operates on the same narrowed sources.
- `truncated: true` semantics unchanged (counted on unique merged candidates in subset).
- Stale-path post-filter (`pathExists`) and `backlink_count` enrichment unchanged.

### Output shape

**Unchanged.** Same envelope across quick / deep / multi-query — just smaller and more relevant.

## File changes

| File                                                     | Change                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/operations/query/index.ts` (or sibling)     | Export `listMatchingPaths(filter, deps)` with path_prefix-only fast-path.                                                                                                                                                                                                          |
| `src/modules/semantic/types.ts`                          | Add `NoteFilter`, `ListMatchingPaths`. Extend `SearchNotesInput` with `filter?: NoteFilter`.                                                                                                                                                                                       |
| `src/modules/semantic/tools/search-notes.ts`             | Add `filter` to zod schema. Add `listMatchingPaths` to `SearchNotesDeps`. Handler: validate filter, build allowed set, narrow Map, early-exit on empty, otherwise delegate to `executeRetrieval` / `executeMultiRetrieval`. Update `SEARCH_NOTES_DESCRIPTION` with hybrid example. |
| `src/modules/semantic/index.ts` (`createSemanticModule`) | Take `listMatchingPaths` as a required dependency.                                                                                                                                                                                                                                 |
| `src/server.ts`                                          | Wire operations → semantic via `listMatchingPaths`.                                                                                                                                                                                                                                |
| `README.md`                                              | New "Pre-filter" subsection under `search_notes`, with hybrid example.                                                                                                                                                                                                             |
| `docs/architecture/retrieval-policy.md`                  | New paragraph describing the pre-filter as a step that narrows `sources` before the existing flow.                                                                                                                                                                                 |
| MCP server instructions                                  | One line: "Use `filter` to scope semantic search to a folder/tag — much better precision on niche queries."                                                                                                                                                                        |

## Validation & error handling

| Situation                                 | Code                                                                                       | Where                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Bad filter shape (zod)                    | `INVALID_ARGUMENT`                                                                         | zod parse in handler        |
| `filter: {}` (all three fields undefined) | `INVALID_ARGUMENT` ("filter must specify at least one of: path_prefix, tags, frontmatter") | handler explicit check      |
| Banned operator inside `frontmatter`      | `INVALID_ARGUMENT`                                                                         | shared `validateFilter`     |
| Bad `path_prefix` shape                   | `INVALID_ARGUMENT`                                                                         | reused from `runQueryNotes` |
| Vault scan failure                        | `DEPENDENCY_ERROR`                                                                         | `wrapDependencyError`       |
| Per-note read error during scan           | silent (matches `query_notes`)                                                             | nothing                     |

`validateFilter` is **re-exported from operations module** so semantic does not duplicate the operator allow-list.

## Tool description (LLM-facing)

`SEARCH_NOTES_DESCRIPTION` gains a new section:

```
- filter: optional structural pre-filter applied BEFORE semantic ranking. Best for niche/domain queries where the vault has many narrative notes that crowd top-K.
  Shape: { path_prefix?, tags?, frontmatter? }. At least one field required.
  - path_prefix: scope to a folder (e.g. "Resources/").
  - tags: notes that have ANY of these tags (OR).
  - frontmatter: sift filter on frontmatter keys (e.g. { type: "reflection", status: "active" }).
  Composition: filter AND threshold AND semantic. Use this instead of querying twice and intersecting on the client.
EXAMPLES:
- "trading reflections" → search_notes({query: "trading lessons", filter: {tags: ["trading"]}}).
- scoped multi-query → search_notes({query: ["embeddings","векторний пошук"], filter: {path_prefix: "Resources/"}, mode: "deep"}).
```

## Testing

All unit tests use DI to stub `listMatchingPaths` and `searchEngine`; no real vault required.

| #   | Scenario                                          | Expectation                                                                                                               |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `filter: { path_prefix: "Resources/" }`           | findNeighbors receives only Resources/ sources; foreign paths absent from result                                          |
| 2   | `filter: { tags: ["trading"] }`                   | listMatchingPaths called with filter; only matched paths in result                                                        |
| 3   | `filter: { frontmatter: { type: "reflection" } }` | filter validated and applied                                                                                              |
| 4   | `filter` + multi-query (`query: ["a","b"]`)       | merge confined to filtered subset; matched_queries present                                                                |
| 5   | `filter` + `mode: "deep"`                         | expansion-derived results lie in allowed set; via_expansion flag present                                                  |
| 6   | Empty allowed set                                 | result `{ results: [] }` (+ `blockResults: []` when deep, `truncated: false` when multi); embed / searchEngine NOT called |
| 7   | No `filter`                                       | identical to current behaviour; listMatchingPaths NOT called                                                              |
| 8   | `filter: {}`                                      | `INVALID_ARGUMENT: filter must specify at least one of: path_prefix, tags, frontmatter`                                   |
| 9   | `filter.frontmatter` with `$where`                | `INVALID_ARGUMENT` from `validateFilter`                                                                                  |
| 10  | `filter` + `threshold`                            | both applied as AND; sub-threshold matches absent                                                                         |
| 11  | path_prefix-only fast-path                        | listMatchingPaths does NOT read frontmatter (spy on `vaultReader.readNotes` → zero calls)                                 |
| 12  | listMatchingPaths throws (scan failure)           | `DEPENDENCY_ERROR`; details include `operation: 'search_notes'`                                                           |

**Existing tests** must continue to pass without behaviour changes (back-compat). Any fixture that constructs `SearchNotesDeps` gets a no-op `listMatchingPaths: async () => new Set()`.

**Optional integration test:** one e2e against a real-FS fixture vault — `filter: { path_prefix: "Notes/" }` returns only `Notes/*.md`. Catches mock-vs-prod drift in the operations↔semantic wiring.

## Definition of Done

- [ ] `search_notes` accepts `filter: { path_prefix?, tags?, frontmatter? }`; all three optional; ≥1 required.
- [ ] `frontmatter` passes the shared `validateFilter` (single operator dictionary across the server).
- [ ] Allowed set computed before semantic; semantic, expansion, multi-query merge, block search all confined to it.
- [ ] Empty allowed set → empty output without embed / searchEngine call.
- [ ] Path_prefix-only fast-path: no frontmatter reads.
- [ ] Cross-module DI: semantic does not import operations directly; `listMatchingPaths` is a dependency.
- [ ] `SEARCH_NOTES_DESCRIPTION` updated with hybrid example.
- [ ] MCP server instructions mention `filter` for precision on niche queries.
- [ ] README section on pre-filter with example.
- [ ] `docs/architecture/retrieval-policy.md` — new paragraph on pre-filter.
- [ ] All three verification gates green: `npm test`, `npm run lint`, `npx tsc --noEmit`.
- [ ] Conventional Commit: `feat(search_notes): add structural pre-filter`. NO `BREAKING CHANGE` (back-compat).
- [ ] Release — minor bump (`5.1.0`) on main after PR merge.

## References

- Vault source: `Tasks/Add structural pre-filter to search_notes.md`
- Related: `docs/superpowers/specs/2026-04-26-multi-query-search-design.md`
- Related: `docs/superpowers/specs/2026-04-27-query-notes-tool-design.md`
- Architecture: `docs/architecture/retrieval-policy.md`, `docs/architecture/query.md`, `docs/architecture/search-engine.md`
