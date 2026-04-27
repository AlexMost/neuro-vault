# Multi-query semantics finalization & per-tool module refactor

**Date:** 2026-04-27
**Status:** Approved (brainstorm)
**Supersedes (in part):**

- `2026-04-26-multi-query-search-design.md` — for cap behavior, expansion semantics, and output shape (the merge/`matched_queries` foundations stand).

## Problem

Two unfinished threads converge:

1. **Multi-query `search_notes`** is implemented at the schema and merge level (per the 2026-04-26 spec), but the cap (`min(limit × N, 50)`) and the expansion step (per-query, before merge) do not match the intent of "give the agent one merged top-`limit` answer." Task `[[Add multi-query support to search_notes]]` revisits both decisions: `limit` should be the final result count regardless of `N`, and expansion should run on the merged top, not on each query separately. A new `via_expansion` flag is introduced so the agent can tell which results were retrieved by a query and which were pulled in through link expansion.
2. **Tool registration is monolithic.** `src/modules/<module>/tools.ts` defines schemas + descriptions for all tools in one file, and `src/modules/<module>/tool-handlers.ts` implements every handler in another. Adding a tool, finding the description for an existing one, or reviewing a single tool's tests all require navigating large files. As the surface grows (now 16 tools across two modules), the pattern stops paying for itself.

This spec ships both as one logical unit because the multi-query behavior changes are isolated to one tool, and isolating that tool is exactly what the refactor does. The refactor lands first as a no-op, the behavior change lands second on the already-isolated module.

## Goals

1. Make `search_notes` multi-query behavior match the agent's mental model: `limit` is the final result count; expansion runs once on the merged top; expanded results are tagged.
2. Restructure tool definitions so each tool is one file (schema + description + handler), with a typed `ITool<I, O>` interface and a thin glue layer that bridges to the MCP SDK's `ToolRegistration`.
3. Mirror the structure in tests: one test file per tool.
4. Ship the refactor as a behavior-preserving baseline (Phase 1) so that the multi-query semantics change (Phase 2) is reviewable in isolation.

## Non-goals

- No parameter renames (the `mcp-param-naming` spec already governs naming).
- No new search modes; no per-query weights / boosts; no per-query different `limit` / `threshold` / `mode`.
- No multi-query for `get_similar_notes`.
- No re-introduction of `expansion` / `expansion_limit` as public schema params (the `search-notes-clarity` spec removed them; that decision stands).
- No transport changes.
- No reorganization beyond `src/modules/<module>/tools/` and the corresponding `test/<module>/tools/` mirror.

## Architecture

Layering after the refactor:

```
src/lib/
  tool-registration.ts    # ToolRegistration (MCP-facing, unchanged)
  tool-registry.ts        # NEW: ITool<I,O> + registerTool(tool, deps)
  tool-response.ts        # invokeTool, ToolHandlerError (unchanged)

src/modules/semantic/
  tools/
    search-notes.ts       # ITool<SearchNotesInput, SearchNotesOutput>
    get-similar-notes.ts
    find-duplicates.ts
    get-stats.ts
    index.ts              # buildSemanticTools(deps) — same external API
  tool-helpers.ts         # NEW: normalizeQuery, normalizeQueryArray, readPositiveInteger, readThreshold
  retrieval-policy.ts     # multi-query merge + post-merge expansion
  embedding-service.ts
  search-engine.ts
  smart-connections-loader.ts
  types.ts                # SearchResult, MultiSearchResult (+ via_expansion), MultiRetrievalOutput, etc.
  index.ts

src/modules/operations/
  tools/
    read-notes.ts
    query-notes.ts
    create-note.ts
    edit-note.ts
    read-daily.ts
    append-daily.ts
    set-property.ts
    read-property.ts
    remove-property.ts
    list-properties.ts
    list-tags.ts
    index.ts
  tool-helpers.ts         # NEW: noteIdentifierShape, resolveNoteIdentifier helpers
  vault-provider.ts
  vault-reader.ts
  obsidian-cli-provider.ts
  frontmatter.ts
  query/
  types.ts
  index.ts
```

`src/modules/<module>/tool-handlers.ts` is **deleted** at the end of Phase 1 — handler logic lives entirely inside per-tool files (calling into module helpers / providers as before).

`server.ts` keeps calling `buildSemanticTools(deps)` and `buildOperationsTools(deps)` exactly as today; the index files preserve those entry points.

## `ITool<I, O>` interface (Phase 1)

```ts
// src/lib/tool-registry.ts
import type { ZodTypeAny, z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRegistration } from './tool-registration.js';
import { invokeTool } from './tool-response.js';

export interface ITool<I, O> {
  name: string;
  title?: string;
  description: string;
  inputSchema: ZodTypeAny; // schema parses to I
  outputSchema?: ZodTypeAny; // optional — not enforced at runtime today
  annotations?: ToolAnnotations;
  handler: (input: I) => Promise<O>;
}

export function registerTool<I, O>(tool: ITool<I, O>): ToolRegistration {
  return {
    name: tool.name,
    spec: {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    handler: async (args) =>
      invokeTool(async () => tool.handler(tool.inputSchema.parse(args) as I)),
  };
}
```

Each tool file constructs its `ITool<I, O>` via a factory that closes over the module's deps:

```ts
// src/modules/semantic/tools/search-notes.ts
import { z } from 'zod';
import type { ITool } from '../../../lib/tool-registry.js';
import type { SemanticToolDeps } from '../types.js';
import {
  normalizeQuery,
  normalizeQueryArray,
  readPositiveInteger,
  readThreshold,
} from '../tool-helpers.js';
import { executeRetrieval, executeMultiRetrieval } from '../retrieval-policy.js';

const inputSchema = z.object({
  query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
  mode: z.enum(['quick', 'deep']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

type Input = z.infer<typeof inputSchema>;
type Output = SearchNotesResult; // single- or multi- shape, see types.ts

export function buildSearchNotesTool(deps: SemanticToolDeps): ITool<Input, Output> {
  return {
    name: 'search_notes',
    title: 'Search Notes',
    description: SEARCH_NOTES_DESCRIPTION,
    inputSchema,
    handler: async (input) => {
      // validation + dispatch (single vs array) lives here, calling retrieval-policy
    },
  };
}
```

`src/modules/semantic/tools/index.ts` aggregates:

```ts
export function buildSemanticTools(deps: SemanticToolDeps): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
    registerTool(buildGetStatsTool(deps)),
  ];
}
```

`SemanticToolDeps` is the existing dep bundle (embedding provider, sources, search engine, pathExists, modelKey). Same shape; just imported from per-tool files instead of a central handler builder.

The same pattern applies to operations.

## Validation helpers (Phase 1)

`src/modules/semantic/tool-helpers.ts` contains the existing pure-function validators currently inside `tool-handlers.ts`:

- `normalizeQuery(value: unknown): string`
- `normalizeQueryArray(value: unknown): string[]` — trims, drops empty/whitespace-only as `INVALID_ARGUMENT`, dedupes by trimmed value, length check 1..8 on **raw input** (so `["a"] × 9` rejects even though dedupe would shrink to 1).
- `readPositiveInteger(value, field): number`
- `readThreshold(value, field): number`

`src/modules/operations/tool-helpers.ts`:

- `noteIdentifierShape` (Zod object shape) plus `resolveNoteIdentifier({ name, path })` — exactly-one check, `INVALID_ARGUMENT` on both/neither.

These mirror what already exists; the move is mechanical.

## Phase 1 — refactor (no behavior change)

Goal: every tool ends up in its own file; all existing tests pass without modification, then test files are split per tool.

### Step list

1. Add `src/lib/tool-registry.ts` with `ITool` and `registerTool`.
2. Create `src/modules/semantic/tool-helpers.ts`; move validators from `tool-handlers.ts`. Update imports inside `tool-handlers.ts`. Tests stay green.
3. For each semantic tool, create `src/modules/semantic/tools/<name>.ts` exporting `buildXxxTool(deps): ITool<I, O>`. Migrate the handler body verbatim from `tool-handlers.ts` (still calling the same `retrieval-policy` / `search-engine` etc.). Schema and description move from `tools.ts`.
4. Create `src/modules/semantic/tools/index.ts` exporting `buildSemanticTools(deps): ToolRegistration[]` that wraps each `buildXxxTool` through `registerTool`.
5. Update `src/modules/semantic/index.ts` to re-export `buildSemanticTools` from `./tools/index.js`.
6. Delete `src/modules/semantic/tools.ts` and `src/modules/semantic/tool-handlers.ts`.
7. Repeat 2–6 for `operations`. (Operations has 11 tools; same mechanics, just more files.)
8. Split `test/semantic/tool-handlers.test.ts` into `test/semantic/tools/<name>.test.ts` files, one per tool. Each new test file imports `buildXxxTool` from the corresponding source module and exercises it directly. Move helper / fixture utilities to `test/semantic/tools/_helpers.ts` if shared.
9. Repeat 8 for operations.
10. Update `tsup` / build config if it pins specific entry files (it shouldn't — it builds via `src/index.ts`, but verify).
11. Run `npm test`, `npm run lint`, `npx tsc --noEmit`. All green is the gate to Phase 2.

`server.ts` is **not modified** in Phase 1. The external API surface (tools listed by `tools/list`, every input/output shape) is byte-identical.

### Acceptance for Phase 1

- `src/modules/<module>/tools.ts` and `src/modules/<module>/tool-handlers.ts` no longer exist.
- Each tool has exactly one source file under `src/modules/<module>/tools/<name>.ts` and one test file under `test/<module>/tools/<name>.test.ts`.
- `npm test` passes with the same number of tests (or more, after splitting). No test was deleted or weakened.
- `npm run lint` and `npx tsc --noEmit` are clean.
- `git diff main..HEAD -- src/server.ts` is empty (no server changes in Phase 1).

## Phase 2 — multi-query semantics

Localized changes in `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/retrieval-policy.ts`, and `src/modules/semantic/types.ts`. Test changes in `test/semantic/tools/search-notes.test.ts` and `test/semantic/retrieval-policy.test.ts`.

### Behavior (multi-query, `query: string[]`)

1. **Validation:** `1 ≤ rawLength ≤ 8` (count rejected on the raw array, before dedupe — `["a"] × 9` fails). Empty / whitespace-only entries → `INVALID_ARGUMENT`. Trim + dedupe before embedding.
2. **Embedding:** `Promise.all` over normalized queries (current behavior; the embedding service has no batch API today, parallelizing the awaits is the closest equivalent and is sufficient).
3. **Per-query retrieval:** each query searches its own top-`limit` notes at the same `mode` / `threshold`. Per-query top-K stays at `limit` — anything outside a single query's top-`limit` has lower similarity than that query's `#limit`, so it cannot survive the merge into the final top-`limit` even if a different query also returned it. (Proof sketch: the final ordering is `max similarity` per path; a path missing from query Q's top-`limit` either was below threshold for Q, or had at least `limit` higher-scoring siblings under Q. In either case, Q does not raise that path's max above whatever a top-`limit` path already has.)
4. **Merge by path:** for each unique path, take the max similarity across queries that returned it (above threshold). `matched_queries` is the list of queries that placed this path into their own top-K **after threshold filtering** — a sub-threshold partial match never appears in `matched_queries`. `matched_queries` is sorted by descending per-query similarity for that path.
5. **Sort:** the merged list is sorted by max similarity desc.
6. **Cap:** truncate the merged list to `limit` (final, **independent of N**). `truncated: true` if the unique merged candidate count was `> limit`. Multi-query no longer multiplies the cap.
7. **Expansion (deep mode only, mode-controlled):** runs **after** merge+cap on the final top-`limit` paths. The expansion step finds neighbors of those seed paths via `search-engine.findNeighbors`, deduplicates against the seeds, and returns up to `expansion_limit` **total** expanded results — the parameter is reinterpreted as a hard cap on the post-expansion expanded count, not a per-seed cap. Each expanded result carries `via_expansion: true` and **no** `matched_queries`. Quick mode never runs expansion.
8. **Block search:** unchanged otherwise (deep: whole corpus; quick: scoped to top notes, threshold=0, cap=5). Multi-query block-search merges by `(path, heading, lines)` exactly the way notes merge by `path`, with the same `matched_queries` semantics. The same final cap applies — block results are not capped to `limit` (block cap is independent, kept at the existing mode-specific value).

### Behavior (single query, `query: string`)

Single-query path uses the same pipeline as multi-query with N=1, but the **output omits `matched_queries`** and (when expansion does not run, i.e., quick mode) omits `truncated`. Existing single-query callsites observe the same shape they do today, plus `via_expansion: true` on expansion-derived results in deep mode (this is the one new field that single-query callers see — acceptable as a minor since the field is purely additive on a path that previously returned an undifferentiated mix).

### Output shape

```ts
// src/modules/semantic/types.ts (additions in italics)

export interface MultiSearchResult {
  path: string;
  similarity: number; // max across matched queries (or seed similarity for via_expansion)
  matched_queries?: string[]; // present iff result came from a query (sorted by per-query sim desc)
  via_expansion?: true; // present iff result was pulled in by post-merge expansion
}

export interface MultiBlockSearchResult {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
  matched_queries?: string[];
  // block expansion is not in scope; via_expansion does not appear here
}

export interface MultiRetrievalOutput {
  results: MultiSearchResult[];
  blockResults?: MultiBlockSearchResult[];
  truncated: boolean; // true iff unique merged candidate count > limit
}

export interface RetrievalOutput {
  // single-query
  results: SearchResult[];
  blockResults?: BlockSearchResult[];
}

export interface SearchResult {
  path: string;
  similarity: number;
  via_expansion?: true; // NEW — appears on deep-mode results pulled in by expansion
}
```

`matched_queries` and `via_expansion` are mutually exclusive on a given result. Within a result, the consumer can check `via_expansion` first; absence of both means single-query, non-expansion result.

### Tool description (`SEARCH_NOTES_DESCRIPTION`)

Updated to reflect the new cap, the post-merge expansion, and the meaning of the two flags. Wording may shift during implementation; structural content (Modes / Parameters / Examples sections from `search-notes-clarity-design.md`) stands. The Parameters section adds explicit lines:

- `limit` is the final result count, both for single-query and multi-query — it is **not** multiplied by the number of queries.
- Multi-query results carry `matched_queries`; deep-mode expansion-derived results carry `via_expansion: true`. The two are mutually exclusive.

### Server instructions (`server.ts`)

The Search routing section already (per the implemented multi-query baseline) recommends arrays. Adjust the wording to:

- Drop any remaining "call multiple times with different queries" leftover phrasing.
- Make `limit` semantics explicit: "`limit` always caps the final list; widening `limit` widens recall; passing more queries widens coverage but does not widen the result count."
- Note that deep mode adds `via_expansion: true` results past the `matched_queries`-bearing seeds.

### Backward compatibility

- `query: string` callsites observe the same response shape as today, plus a possible `via_expansion: true` flag on individual `results[]` entries when `mode: "deep"`. No field is removed or renamed.
- `query: string[]` callsites observe a different `truncated` value than the current implementation (now driven by `> limit` rather than `> min(limit × N, 50)`) and a different total result count (capped at `limit` instead of `min(limit × N, 50)`). This is the intended behavior change. The `feat!` commit calls it out; release notes call it out.
- All existing tests of multi-query (cap=`min(limit × N, 50)`) need updates to the new semantics — they are part of Phase 2.

### Error handling

No new error codes. Existing `INVALID_ARGUMENT` paths cover:

- empty array, > 8 elements (raw count, before dedupe);
- empty / whitespace-only element;
- non-string element in array.

`DEPENDENCY_ERROR` continues to wrap embedding / retrieval failures.

### Testing

Unit, in `test/semantic/tools/search-notes.test.ts` (after Phase 1 split):

- `query: string` → no `matched_queries`, no `truncated`.
- `query: string` (deep mode) → expansion-derived results carry `via_expansion: true`; non-expansion results do not.
- `query: string[]` length 1 → equivalent to the string variant in result content (still has `matched_queries` per the back-compat rule from the earlier spec — confirm: yes, `query: string[]` always carries `matched_queries`, even at length 1, so the LLM contract on the array path is uniform).
- `["foo ", "foo"]` → trim + dedupe to one embedding call.
- `[""]` / `["  "]` → `INVALID_ARGUMENT`.
- `[]` and `["a"] × 9` → `INVALID_ARGUMENT` (raw length check).
- Merge: a path returned by two queries → one result, `matched_queries` lists both, sorted by per-query similarity desc.
- A path matched by one query above threshold and another below threshold → `matched_queries` lists only the above-threshold query.
- Final list sorted by max similarity desc.
- Cap: `limit=10`, 3 queries with disjoint top-10 → final length ≤ 10.
- Cap: `limit=10`, 1 query → final length ≤ 10 (back-compat path).
- `truncated: true` when unique merged candidates > `limit`; `truncated: false` otherwise.
- Expansion (deep, multi-query): runs once on the merged top-`limit`. `expansion_limit` is the total cap on expanded results, not per-seed. Expanded results carry `via_expansion: true` and have **no** `matched_queries`.
- Expansion (deep, single-query): runs on the final top-`limit`; expanded results carry `via_expansion: true`.
- Expansion (quick, single or multi): never runs.

Integration (real embeddings, no network), under `test/semantic/`:

- `["оптимізація", "optimization"]` (UA/EN) returns at least the union of paths each single query returns at the same threshold.
- `["MCP server", "MCP сервер", "neuro-vault"]` (three-way synonym) merges stably: same set across two runs given the same fixture.

Performance (manual, documented in PR description):

- Multi-query of 4 queries no more than 2× the wall-clock of a single-query at the same mode (search is linear in N over a static fixture; embedding is the variable factor and parallelizes acceptably for small N).

### Acceptance for Phase 2

- `src/modules/semantic/types.ts` reflects the new fields (`via_expansion?: true` on `SearchResult` and `MultiSearchResult`; `truncated` semantics per `> limit`).
- `retrieval-policy.ts` runs expansion **once** on the post-merge+cap top, in deep mode only, capped at `expansion_limit` total expanded results.
- `tool-helpers.ts` validators reject empty / whitespace / out-of-range raw counts.
- Tool description and `server.ts` Search routing wording match the spec above.
- Tests in the list above all pass.
- `npm test`, `npm run lint`, `npx tsc --noEmit` clean.
- README / `docs/guide/semantic-search.md` updated for the new `limit` semantics and the two flags.

## Definition of Done (combined)

- Phase 1 acceptance met (refactor, no behavior change, all green).
- Phase 2 acceptance met (multi-query semantics, all green).
- One PR to `main` containing both phases as separate commits (`refactor:` for Phase 1, `feat!:` for Phase 2).
- Changelog entry for the breaking change (cap and expansion semantics).
- New minor version released per AGENTS.md flow on `main`.
- Manual smoke run on a real vault (UA/EN multi-query in deep mode, observe `matched_queries` and `via_expansion`).
- Vault `AGENTS.md` updated to recommend array form (post-release).

## Open questions

None at brainstorm time. Surface during implementation if any.

## Connections

- `2026-04-26-multi-query-search-design.md` — original multi-query proposal; this spec supersedes its cap and expansion sections.
- `2026-04-27-search-notes-clarity-design.md` — removed `expansion` / `expansion_limit` from public schema; this spec leaves that decision intact and reinterprets the internal `expansion_limit` semantics.
- `2026-04-23-hybrid-search-routing-design.md` — source of the Search routing section in `server.ts`.
- `2026-04-27-query-notes-tool-design.md` — adjacent operations work; refactor structure (per-tool modules) eases such future additions.
