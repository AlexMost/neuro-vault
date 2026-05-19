# `search_notes` filter — multi-prefix include and exclude

Date: 2026-05-19
Status: Approved (awaits implementation)
Source: `Tasks/neuro-vault — search_notes path filters.md` (vault)
Supersedes scope-exclusion in `2026-05-06-search-notes-structural-pre-filter-design.md` ("Negation filters (`exclude_path_prefix`)").

## Goal

Precision-tune `search_notes.filter` so a single MCP call can scope across multiple folders OR carve out noisy subtrees that today bleed into top-K. The structural pre-filter shipped in May 2026 only accepts a single `path_prefix` and has no negative form. Real sessions show recurring noise from `Resources/` and `Archive/` at similarity ≥ 0.76 — above default thresholds, so threshold tuning cannot fix this. A reranker would, but that is a separate research spike (`Tasks/Research reranker stage for search_notes`); this change is the cheap, deterministic precision lever.

## Scope

Two related changes to the `filter` object accepted by `search_notes`:

1. `filter.path_prefix` accepts `string | string[]`. Array form = OR semantics: a note is included iff its path starts with **any** of the prefixes.
2. New `filter.exclude_path_prefix?: string | string[]`. A note is rejected if its path starts with **any** of the listed prefixes.

```ts
filter?: {
  path_prefix?:         string | string[];
  exclude_path_prefix?: string | string[];
  tags?:                string[];
  frontmatter?:         Record<string, unknown>;
}
```

`exclude_path_prefix` alone is a valid filter (i.e. without `path_prefix`, `tags`, or `frontmatter`). The semantic intent — "search the whole vault except these subtrees" — is real and the principal motivating use case.

## Composition

Order of evaluation against a candidate note path `p`:

1. **Include.** If `path_prefix` is set, `p` must match at least one of the listed prefixes; otherwise the entire vault is the candidate set.
2. **Exclude.** If `exclude_path_prefix` is set, `p` is rejected if it matches at least one listed prefix. Exclude wins over include on intersection — e.g. `path_prefix: ["Tasks/"], exclude_path_prefix: ["Tasks/done/"]` keeps `Tasks/` minus `Tasks/done/`.
3. **Tags / frontmatter / threshold / semantic** — unchanged, AND-composed downstream as in the May 2026 spec.

### Prefix-matching rule

A prefix `Q` matches path `p` iff `p === Q` or `p` starts with `Q + '/'` after both are normalized. Normalization is the existing `normalizeVaultPathPrefix`: strip leading `./`, trailing `/`, reject absolute paths and `..` segments. This means `exclude_path_prefix: "Resources"` rejects `Resources/foo.md` and `Resources.md`-as-a-folder, but **not** `Resources-archive/`. Today's single-prefix scan implicitly enforces this via cwd-rooted globbing; the exclude path needs to enforce it explicitly because it filters paths already returned.

## Architecture

Change is localized to three modules. No changes to `VaultReader.scan` — the reader stays single-prefix, the union/exclude logic lives in the query layer where it belongs.

### `NoteFilter` (in `src/lib/obsidian/query/list-matching-paths.ts`)

```ts
export interface NoteFilter {
  path_prefix?: string | string[];
  exclude_path_prefix?: string | string[];
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}
```

### `createListMatchingPaths`

Normalize and validate arrays up front: empty arrays → `INVALID_FILTER`; per-element → `normalizeVaultPathPrefix` (already throws on absolute paths and `..`). Deduplicate.

Decision branches after normalization:

- **Fast path** (only `path_prefix` and/or `exclude_path_prefix`, no `tags`, no `frontmatter`):
  - If include is set: `Promise.all(includes.map(p => reader.scan({ pathPrefix: p })))`, union into a `Set`.
  - If include is absent (exclude-only): `reader.scan({ pathPrefix: undefined })` — full vault.
  - Apply exclude filter (`Set.prototype.delete` for paths matching any exclude prefix).
- **General path** (tags / frontmatter present):
  - For each include prefix (or `[undefined]` if absent), run `collectMatchingPaths` in parallel with that prefix.
  - Union results by path.
  - Apply exclude filter on the union.

`collectMatchingPaths` itself stays unchanged; the orchestration above runs it N times for N include prefixes. For an N=1 include (the common case) this is identical to current behavior. For exclude-only, N=1 with `undefined` prefix (full scan), then post-filter.

### `search_notes` handler (`src/modules/semantic/tools/search-notes.ts`)

- `filterSchema` zod: `path_prefix: z.union([z.string(), z.array(z.string()).min(1)]).optional()`, `exclude_path_prefix` likewise.
- `SearchNotesInput.filter` type updated to mirror.
- `isFilterEmpty` recognises `exclude_path_prefix` as a populating field, so an exclude-only filter is valid.
- The current error message `"filter must specify at least one of: path_prefix, tags, frontmatter"` updates to include `exclude_path_prefix`.

### Tool description and docs

- Inline description in `search-notes.ts` (the `PRE-FILTER` block): add `exclude_path_prefix` to the field list, add one example using it.
- `docs/guide/semantic-search.md`: update the `filter` type and field list. Show the canonical "active thinking" example from the source vault note: `exclude_path_prefix: ["Resources/", "Archive/"]`.
- `README.md` line 75: extend the one-liner mention to name `exclude_path_prefix`.

## Error model

| Condition                                        | Error                                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path_prefix: []`                                | `INVALID_FILTER`, message `"path_prefix must contain at least one prefix"`                                                                                                                                                         |
| `exclude_path_prefix: []`                        | `INVALID_FILTER`, same shape                                                                                                                                                                                                       |
| Any element is an absolute path or contains `..` | `INVALID_FILTER` from `normalizeVaultPathPrefix` (existing path)                                                                                                                                                                   |
| Element exists as a non-directory or is missing  | `PATH_NOT_FOUND` from `VaultReader.scan` for the _first_ failing include prefix; exclude prefixes referring to non-existent subtrees are silently ignored (they exclude nothing, which is the correct identity for "not present"). |
| Filter object is empty (no field populated)      | `INVALID_ARGUMENT` in `search_notes`, identical to today                                                                                                                                                                           |

The asymmetry on missing subtrees is intentional: an include pointing at a non-existent path is a likely typo and should fail loudly; an exclude pointing at one is harmless and should not block the query.

## Out of scope

- **Regex / glob in path filters.** Prefix patterns cover the named cases (`Resources/`, `Archive/`, `Daily/`). Add `path_regex` only on a real case.
- **`query_notes.path_prefix` (top-level, not under filter).** That parameter stays scalar. The MCP parameter dictionary names `path_prefix` as a single concept across tools; if `query_notes` ever needs multi-prefix, extend in a separate spec so the two API surfaces move together.
- **Hybrid rerank, threshold tuning, tree response shape.** Tracked as separate vault tasks; explicitly not bundled here.
- **Mirroring `exclude_path_prefix` into `get_note_links`.** Separate vault task `Tasks/Add path-prefix filter to get_note_links`, awaiting its own trigger signal. Semantics are aligned by this spec so when it lands it can copy the validation logic.

## Test plan

`test/lib/obsidian/query/list-matching-paths.test.ts` — unit, fast-path and general path:

- `path_prefix: "Tasks/"` (scalar) — identical to current behavior.
- `path_prefix: ["Tasks/", "Reflections/"]` — OR; result is union of both subtrees.
- `exclude_path_prefix: "Resources/"` alone — valid; returns all paths not under `Resources/`.
- `exclude_path_prefix: ["Resources/", "Archive/"]` — neither subtree appears.
- `path_prefix: ["Tasks/"] + exclude_path_prefix: ["Tasks/done/"]` — include then exclude.
- Prefix-boundary: `exclude_path_prefix: "Resources"` does **not** drop `Resources-archive/foo.md`.
- `path_prefix: []` → `INVALID_FILTER`.
- `exclude_path_prefix: []` → `INVALID_FILTER`.
- Include with one valid + one missing prefix → `PATH_NOT_FOUND` on the missing one.
- Exclude with a missing prefix → silently no-ops, results unchanged.
- General path (`tags` present): `path_prefix: ["A/", "B/"] + tags: ["x"]` runs `collectMatchingPaths` twice in parallel and unions; `exclude_path_prefix` post-filters.

`test/semantic/tools/search-notes-filter.test.ts`:

- Filter with only `exclude_path_prefix` — does NOT throw `INVALID_ARGUMENT`; reaches retrieval.
- Filter with `path_prefix: []` — `INVALID_ARGUMENT`.
- Filter with `exclude_path_prefix: []` — `INVALID_ARGUMENT`.
- `path_prefix: ["A/", "B/"]` produces `sources` map containing both subtrees.
- `exclude_path_prefix: ["A/"]` removes `A/*` from `sources` before search.

`test/semantic/tools/search-notes.test.ts`: smoke that existing scalar callers still pass — no behavior change.

## Definition of Done

- `filter.path_prefix` accepts `string | string[]`; scalar form behaviorally identical to today.
- `filter.exclude_path_prefix` accepted as `string | string[]`; valid as a sole filter field.
- Validation errors per the error model table above.
- Tool description (in `search-notes.ts`), `docs/guide/semantic-search.md`, and `README.md` updated with one realistic `exclude_path_prefix` example.
- CHANGELOG entry under `feat:` for the next minor (Conventional Commits drives the version bump on `npm run release`).
- `npm test`, `npm run lint`, `npx tsc --noEmit` — green.

## Expected impact

The source vault note shows 4 of 5 noisy hits on a real "active thinking" query came from `Resources/` and `Archive/`. A single `exclude_path_prefix: ["Resources/", "Archive/"]` removes them deterministically without touching thresholds or the embedding model.
