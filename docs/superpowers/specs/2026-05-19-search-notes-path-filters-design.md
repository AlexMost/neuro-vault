# Path filters — multi-prefix include + exclude across `search_notes` and `query_notes`

Date: 2026-05-19
Status: Approved (awaits implementation)
Source: `Tasks/neuro-vault — search_notes path filters.md` (vault)
Supersedes scope-exclusion in `2026-05-06-search-notes-structural-pre-filter-design.md` ("Negation filters (`exclude_path_prefix`)").

## Goal

Precision-tune the structural path filter so a single MCP call can scope across multiple folders OR carve out noisy subtrees that today bleed into top-K. The pre-filter shipped in May 2026 only accepts a single `path_prefix` and has no negative form. Real sessions show recurring noise from `Resources/` and `Archive/` at similarity ≥ 0.76 — above default thresholds, so threshold tuning cannot fix this. A reranker would, but that is a separate research spike (`Tasks/Research reranker stage for search_notes`); this change is the cheap, deterministic precision lever.

The change applies symmetrically to both vault-scanning tools — `search_notes.filter` and top-level `query_notes` parameters — because the MCP parameter dictionary in `AGENTS.md` keeps `path_prefix` as a single cross-tool concept; the two surfaces move together.

## Scope

Two related changes to path filtering, applied symmetrically to **`search_notes.filter`** and **top-level `query_notes` parameters**:

1. `path_prefix` accepts `string | string[]`. Array form = OR semantics: a note is included iff its path starts with **any** of the prefixes.
2. New `exclude_path_prefix?: string | string[]`. A note is rejected if its path starts with **any** of the listed prefixes.

### `search_notes` shape

```ts
filter?: {
  path_prefix?:         string | string[];
  exclude_path_prefix?: string | string[];  // NEW
  tags?:                string[];
  frontmatter?:         Record<string, unknown>;
}
```

`exclude_path_prefix` alone is a valid filter (i.e. without `path_prefix`, `tags`, or `frontmatter`). The semantic intent — "search the whole vault except these subtrees" — is real and the principal motivating use case.

### `query_notes` shape

```ts
{
  filter:               Record<string, unknown>;      // unchanged
  path_prefix?:         string | string[];            // widened
  exclude_path_prefix?: string | string[];            // NEW
  sort?: { field, order };
  limit?: number;
  include_content?: boolean;
}
```

`path_prefix` and `exclude_path_prefix` are top-level on `query_notes` (not under `filter`) because `filter` is the sift/MongoDB filter object — the MCP parameter dictionary keeps `path_prefix` outside that object. Their semantics and validation are identical to `search_notes`.

## Composition

Order of evaluation against a candidate note path `p`:

1. **Include.** If `path_prefix` is set, `p` must match at least one of the listed prefixes; otherwise the entire vault is the candidate set.
2. **Exclude.** If `exclude_path_prefix` is set, `p` is rejected if it matches at least one listed prefix. Exclude wins over include on intersection — e.g. `path_prefix: ["Tasks/"], exclude_path_prefix: ["Tasks/done/"]` keeps `Tasks/` minus `Tasks/done/`.
3. **Tags / frontmatter / threshold / semantic** — unchanged, AND-composed downstream as in the May 2026 spec.

### Prefix-matching rule

A prefix `Q` matches path `p` iff `p === Q` or `p` starts with `Q + '/'` after both are normalized. Normalization is the existing `normalizeVaultPathPrefix`: strip leading `./`, trailing `/`, reject absolute paths and `..` segments. This means `exclude_path_prefix: "Resources"` rejects `Resources/foo.md` and `Resources.md`-as-a-folder, but **not** `Resources-archive/`. Today's single-prefix scan implicitly enforces this via cwd-rooted globbing; the exclude path needs to enforce it explicitly because it filters paths already returned.

## Architecture

Changes are localized. No changes to `VaultReader.scan` — the reader stays single-prefix, the union/exclude logic lives in the query layer where it belongs. A small shared helper centralizes prefix normalization and exclude-matching so both tools have identical semantics.

### Shared helper (new): `path-prefix-set.ts`

A pure module under `src/lib/obsidian/query/`:

```ts
export type PrefixInput = string | string[] | undefined;

// Throws ToolHandlerError('INVALID_FILTER'|'INVALID_PARAMS') on []/absolute/'..'.
// Returns undefined when input is undefined; never returns an empty array.
export function normalizePrefixList(
  raw: PrefixInput,
  field: 'path_prefix' | 'exclude_path_prefix',
  errorCode: 'INVALID_FILTER' | 'INVALID_PARAMS',
): string[] | undefined;

// True iff `p === q` or `p` starts with `q + '/'`, for any q in `prefixes`.
export function matchesAnyPrefix(p: string, prefixes: string[]): boolean;
```

`normalizePrefixList` builds on the existing `normalizeVaultPathPrefix` so absolute-path / `..` rejection stays in one place. The error code is parametrized because `search_notes` raises `INVALID_FILTER` (mapped to `INVALID_ARGUMENT` by its handler), while `query_notes` raises `INVALID_PARAMS` directly — matching the conventions each tool already uses.

### `NoteFilter` and `createListMatchingPaths`

```ts
export interface NoteFilter {
  path_prefix?: string | string[];
  exclude_path_prefix?: string | string[];
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}
```

Normalize via `normalizePrefixList` up front. Decision branches:

- **Fast path** (only `path_prefix` and/or `exclude_path_prefix`, no `tags`, no `frontmatter`):
  - If include is set: `Promise.all(includes.map(p => reader.scan({ pathPrefix: p })))`, union into a `Set`.
  - If include is absent (exclude-only): `reader.scan({ pathPrefix: undefined })` — full vault.
  - If exclude is set: drop entries where `matchesAnyPrefix(path, excludes)`.
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

### `query_notes` handler and `runQueryNotes`

**Zod schema** (`src/modules/operations/tools/query-notes.ts`):

```ts
path_prefix:         z.union([z.string(), z.array(z.string()).min(1)]).optional(),
exclude_path_prefix: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
```

**`QueryNotesToolInput` type** (`src/lib/obsidian/query/types.ts`): widened accordingly.

**`runQueryNotes` (`src/lib/obsidian/query/query-notes.ts`)**:

- `validateInput` calls `normalizePrefixList` for both fields with `errorCode: 'INVALID_PARAMS'`. The resulting `ValidatedInput` carries `includePrefixes?: string[]` and `excludePrefixes?: string[]`.
- Execution:
  - If `includePrefixes` is `undefined` (no include): run `collectMatchingPaths` once with `pathPrefix: undefined` — identical to today.
  - If `includePrefixes.length === 1`: run `collectMatchingPaths` once with that prefix — also identical to today, including the early-exit optimization.
  - If `includePrefixes.length > 1`: run `collectMatchingPaths` per prefix in parallel, **with `earlyExitAfter` disabled**, union the row sets by `record.path`. (See "Early-exit trade-off" below.)
  - After matching, if `excludePrefixes` is set: drop rows where `matchesAnyPrefix(record.path, excludePrefixes)`.
- Sort, truncate, slice — all on the post-exclude set, unchanged.

**Early-exit trade-off.** Currently `runQueryNotes` enables `earlyExitAfter` only when sort order matches the natural scan order (`undefined` sort or `sort: { field: "path", order: "asc" }`). With multi-prefix include, that invariant breaks — each prefix scan is independently ordered, and merging them defeats early termination unless we add a streaming union. The simpler choice: with multi-prefix, scan all matched rows. This regresses worst-case latency on huge subtrees only when the caller opts into multi-prefix; single-prefix is unchanged. Single-prefix + exclude keeps early-exit (the exclude post-filter cannot bring matches _back_, only remove them; the existing cap-plus-one logic still correctly distinguishes "exactly N" from "more than N"). Documented as an explicit caveat.

### Tool descriptions and docs

- `search_notes` description (in `search-notes.ts`, `PRE-FILTER` block): add `exclude_path_prefix` to field list + one example.
- `query_notes` description (in `query-notes.ts`): expand the `path_prefix` sentence and add an `exclude_path_prefix` sentence.
- `docs/guide/semantic-search.md`: update `filter` type and field list. Canonical "active thinking" example: `exclude_path_prefix: ["Resources/", "Archive/"]`.
- `docs/guide/vault-operations.md` (line 96): widen `path_prefix` type and add `exclude_path_prefix`.
- `docs/architecture/query.md` (line 27 area): note multi-prefix scan and early-exit trade-off in the pipeline summary.
- `README.md`: extend the one-line `filter` mention to name `exclude_path_prefix`.
- `AGENTS.md` MCP parameter dictionary: the `path_prefix` row notes that values can be string or array; add a row for `exclude_path_prefix`.

## Error model

Error _codes_ differ between tools (matching today's conventions); error _conditions_ are identical.

| Condition                                        | `search_notes`                                                                                                                     | `query_notes`                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `path_prefix: []`                                | `INVALID_FILTER` → mapped to `INVALID_ARGUMENT`                                                                                    | `INVALID_PARAMS`                                         |
| `exclude_path_prefix: []`                        | same                                                                                                                               | same                                                     |
| Any element is an absolute path or contains `..` | `INVALID_FILTER` → `INVALID_ARGUMENT`                                                                                              | `INVALID_PARAMS`                                         |
| Element exists as a non-directory or is missing  | `PATH_NOT_FOUND` for the _first_ failing include prefix; exclude prefixes referring to non-existent subtrees are silently ignored. | same                                                     |
| Filter object is empty (no field populated)      | `INVALID_ARGUMENT`, identical to today                                                                                             | n/a — `query_notes.filter` is sift, validated separately |

The asymmetry on missing subtrees is intentional: an include pointing at a non-existent path is a likely typo and should fail loudly; an exclude pointing at one is harmless and should not block the query.

## Out of scope

- **Regex / glob in path filters.** Prefix patterns cover the named cases (`Resources/`, `Archive/`, `Daily/`). Add `path_regex` only on a real case.
- **Hybrid rerank, threshold tuning, tree response shape.** Tracked as separate vault tasks; explicitly not bundled here.
- **Mirroring `exclude_path_prefix` into `get_note_links`.** Separate vault task `Tasks/Add path-prefix filter to get_note_links`, awaiting its own trigger signal. Semantics are aligned by this spec so when it lands it can copy `matchesAnyPrefix` from the shared helper.
- **Streaming union with early-exit for multi-prefix `query_notes`.** Possible future optimization; not worth the complexity until a real caller hits the regression.

## Test plan

### Shared helper

`test/lib/obsidian/query/path-prefix-set.test.ts` (new):

- `normalizePrefixList(undefined, ...)` → `undefined`.
- `normalizePrefixList("Tasks/", ...)` → `["Tasks"]` (single, normalized).
- `normalizePrefixList(["Tasks/", "Reflections/"], ...)` → both normalized.
- `normalizePrefixList([], ...)` → throws with the requested error code.
- `normalizePrefixList(["/abs"], ...)` → throws (delegates to `normalizeVaultPathPrefix`).
- `normalizePrefixList(["a", "a"], ...)` → dedupes to `["a"]`.
- `matchesAnyPrefix("Resources/foo.md", ["Resources"])` → `true`.
- `matchesAnyPrefix("Resources-archive/foo.md", ["Resources"])` → `false` (boundary).
- `matchesAnyPrefix("Resources", ["Resources"])` → `true` (exact).

### `list-matching-paths`

`test/lib/obsidian/query/list-matching-paths.test.ts`:

- `path_prefix: "Tasks/"` (scalar) — identical to current behavior.
- `path_prefix: ["Tasks/", "Reflections/"]` — OR; union of both subtrees.
- `exclude_path_prefix: "Resources/"` alone — valid; returns all paths not under `Resources/`.
- `exclude_path_prefix: ["Resources/", "Archive/"]` — neither subtree appears.
- `path_prefix: ["Tasks/"] + exclude_path_prefix: ["Tasks/done/"]` — include then exclude.
- Prefix-boundary: `exclude_path_prefix: "Resources"` does **not** drop `Resources-archive/foo.md`.
- `path_prefix: []` → `INVALID_FILTER`.
- `exclude_path_prefix: []` → `INVALID_FILTER`.
- Include with one valid + one missing prefix → `PATH_NOT_FOUND`.
- Exclude with a missing prefix → silently no-ops.
- General path: `path_prefix: ["A/", "B/"] + tags: ["x"]` runs `collectMatchingPaths` twice in parallel and unions; `exclude_path_prefix` post-filters.

### `search_notes`

`test/semantic/tools/search-notes-filter.test.ts`:

- Filter with only `exclude_path_prefix` — does NOT throw `INVALID_ARGUMENT`; reaches retrieval.
- Filter with `path_prefix: []` — `INVALID_ARGUMENT`.
- Filter with `exclude_path_prefix: []` — `INVALID_ARGUMENT`.
- `path_prefix: ["A/", "B/"]` produces `sources` map containing both subtrees.
- `exclude_path_prefix: ["A/"]` removes `A/*` from `sources` before search.

### `query_notes`

`test/lib/obsidian/query/query-notes.test.ts`:

- `path_prefix: "Tasks/"` (scalar) — behavior identical to today, early-exit still active when sort is path-asc or absent.
- `path_prefix: ["A/", "B/"]` — results union both subtrees; early-exit disabled (verify by sending a filter where >limit notes match and confirming `truncated: true` reflects the full match count, not just one prefix's).
- `exclude_path_prefix: "Archive/"` alone — full vault minus `Archive/`.
- `exclude_path_prefix: "Daily/" + path_prefix: "Reflections/"` — `Daily/` carve-out applied even though prefix already excludes it (no-op but valid).
- `path_prefix: []` → `INVALID_PARAMS`.
- `exclude_path_prefix: []` → `INVALID_PARAMS`.
- Missing include prefix → `PATH_NOT_FOUND`.
- Missing exclude prefix → silently no-op.

`test/lib/obsidian/query/integration.test.ts`: a real-FS smoke for `path_prefix: ["a/", "b/"] + exclude_path_prefix: ["a/inner/"]` against a temporary vault, end-to-end through `runQueryNotes`.

### Smoke

`test/semantic/tools/search-notes.test.ts`, `test/server-instructions.test.ts`, `test/server-modules.test.ts`: existing scalar callers still pass — no behavior change.

## Definition of Done

- `search_notes`: `filter.path_prefix` accepts `string | string[]`; `filter.exclude_path_prefix` accepted; exclude-only filter valid; scalar form behaviorally identical to today.
- `query_notes`: top-level `path_prefix` accepts `string | string[]`; new `exclude_path_prefix`; scalar `path_prefix` with default sort retains its early-exit optimization.
- Shared helper `path-prefix-set.ts` consumed by both tools so validation and prefix-matching live in one place.
- Validation errors per the error model table above.
- Tool descriptions, `docs/guide/semantic-search.md`, `docs/guide/vault-operations.md`, `docs/architecture/query.md`, `README.md`, and the `AGENTS.md` MCP parameter dictionary all updated with one realistic example each.
- CHANGELOG entry under `feat:` for the next minor (Conventional Commits drives the version bump on `npm run release`).
- `npm test`, `npm run lint`, `npx tsc --noEmit` — green.

## Expected impact

The source vault note shows 4 of 5 noisy hits on a real "active thinking" query came from `Resources/` and `Archive/`. A single `exclude_path_prefix: ["Resources/", "Archive/"]` removes them deterministically without touching thresholds or the embedding model.
