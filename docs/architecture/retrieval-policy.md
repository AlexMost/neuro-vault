# Retrieval Policy

How a search request becomes a ranked set of notes and blocks. This is the "policy" layer that composes the embedding pipeline, the corpus, and the search engine into the behaviour described to the LLM.

## What it is

`src/retrieval-policy.ts` exports a single function, `executeRetrieval(input)`, that runs a four-step pipeline:

1. Embed the query.
2. Find note-level neighbors (with a fallback if nothing matches).
3. Find block-level neighbors (scoped to seed notes).
4. Optionally expand per seed by treating each top result as a new query vector.

The output is `{ results: NoteResultNode[] }` — a tree where each result note carries its own `blocks[]` (section-level matches within that note) and `related[]` (per-seed expansion neighbours in deep mode).

## Flow

```
query
  │
  ▼
[embed] ──► query_vector
  │
  ▼
[findNeighbors threshold] ─► note results (top-K)
  │   (if empty AND threshold>0.3: retry at 0.3)
  ▼
slice(0, limit) ──► seed notes
  │
  ▼
[block search per seed note] ──► block per note
  │   quick: threshold=0, cap=5 (engine-side)
  │   deep:  threshold=mode, limit=mode
  │   (sources narrowed to seed notes — orphan blocks dropped)
  ▼
[per-seed expansion] (deep only) ──► related[] per seed
  │   each seed asks for perSeedLimit + seedCount neighbours,
  │   filters out other seeds, sorts, slices to perSeedLimit
  ▼
assemble tree: { path, similarity, blocks[], related[] }
```

## Why it exists

The search engine is pure math; the LLM-facing tool needs a higher-level behaviour: "if the user wants a quick lookup, give me a few high-confidence matches; if the user is exploring, cast a wider net and surface relevant paragraphs." Encoding that behaviour as a policy keeps the math layer simple and gives one place to tune the trade-offs.

## Modes

```
quick: limit=3, threshold=0.50, expansion=off
deep:  limit=8, threshold=0.35, expansion=on, expansionLimit=3
```

- `quick` is the default — used for specific lookups where the LLM expects a small, precise answer set.
- `deep` lowers the threshold, doubles+ the limit, and turns on expansion — used for "tell me about X" exploration.

The LLM picks the mode based on intent; the user can override per call.

## Step 1 — Embedding

Just calls `embeddingProvider.embed(query)`. If embedding fails, the policy lets the error bubble; the tool handler wraps it as `DEPENDENCY_ERROR`.

## Step 2 — Note-level neighbors with threshold fallback

```
results = findNeighbors(threshold)
if results is empty AND threshold > 0.3:
    results = findNeighbors(0.3)
```

The fallback exists because users rarely tune the threshold, and the difference between "no results" and "weak results" is more useful than silence. The 0.3 floor stays high enough to keep results meaningful but low enough to surface weak matches the user can decide about.

## Step 3 — Block-level results, scoped to seed notes

Block search runs over the **seed notes** (the top-K from step 2), not the whole corpus. This is the source of the orphan-block guarantee: if a block's note did not make the note-level top-K, the block is not surfaced.

- `deep` mode: block search uses the mode's `threshold` and `limit`.
- `quick` mode: block search uses `threshold = 0` and `cap = QUICK_BLOCK_LIMIT = 5`.

When seed-note count is 0, block search is skipped entirely. Blocks per note are sorted by `similarity` desc with `lines[0]` as tiebreak.

## Step 4 — Per-seed expansion

If `expansion` is on and there are seeds, each seed gets its own `related[]` list. `computeRelatedPerSeed` asks the search engine for `perSeedLimit + seedCount` neighbours per seed (the `+ seedCount` is headroom so that if some top neighbours are themselves seeds and get filtered out, the cap can still be reached), filters out any neighbour whose path is a seed, sorts by similarity desc, and slices to `perSeedLimit`.

Crucially, there is **no global dedup across seeds**: the same neighbour path may appear in `related[]` of multiple seeds, each carrying its own `expansion_similarity` to that parent. Neighbourhood is a pairwise property.

`related[]` items carry `{ path, expansion_similarity }` only — never the top-level `similarity` field. The two scales (query-similarity vs note-to-note similarity) are deliberately kept distinct.

## Multi-query

`executeMultiRetrieval(input)` runs the per-query embed + retrieval (with threshold fallback) in parallel via `Promise.all`, then merges and assembles a tree-shaped output.

Merge rule for note seeds (`mergeNoteResults` → `MergedSeed[]`):

- key by `path`
- similarity is `max` across the queries that matched it
- `matched_queries: string[]` records which queries surfaced this path

After merging, seeds are sorted by similarity descending (with path tiebreak). `truncated = merged.length > limit`. Then seeds are sliced to `limit`.

Block search runs **per query** with each query's own vector, scoped to seed notes; the per-query block hits are deduped by `(path, heading, lineRange)` keeping max similarity, then bucketed under each seed and sorted by similarity desc. The NUL character is used as the in-key separator so headings containing spaces (`#Meeting Notes`) cannot collide.

Per-seed expansion reuses the same `computeRelatedPerSeed` helper as single-query — no duplicated expansion logic.

Output: `{ results: MultiNoteResultNode[], truncated: boolean }`. Each `MultiNoteResultNode` extends `NoteResultNode` with `matched_queries: string[]`.

## Invariants

- Results are sorted by similarity descending; `blocks[]` per note sorted by similarity desc with `lines[0]` tiebreak; `related[]` per seed sorted by `expansion_similarity` desc with `path` tiebreak.
- Final note count is bounded by `input.limit ?? mode.limit`.
- `related[]` is bounded by `expansionLimit` (default `3`) **per seed** — total count is up to `seedCount × expansionLimit`, with duplicates allowed across seeds.
- `blocks[]` belong strictly to their parent note; orphan blocks (blocks whose note is not in `results[]`) are dropped.
- `similarity` lives only on direct results. `expansion_similarity` lives only on `related[]` items. They never co-occur on the same object.
- User-supplied `threshold` and `limit` override the mode defaults; `expansion` and `expansionLimit` are fixed by mode and not exposed to MCP callers.

## Stale-path filtering

The Smart Connections embeddings index is keyed by note path. When a file is moved (e.g. `Tasks/foo.md` → `Archive/foo.md`) Smart Connections may not evict the old entry, so `findNeighbors` can return a path that no longer exists on disk. The MCP `search_notes`, `get_similar_notes`, and `find_duplicates` handlers post-filter results through a `pathExists(vaultRelativePath)` predicate and drop entries (and duplicate pairs) whose paths are missing.

The default predicate in `src/modules/semantic/index.ts` is a `fs.access` check rooted at the configured `--vault` directory. Tests inject a fake. The policy itself is unchanged — filtering happens at the handler boundary so the math layer stays pure.

## Pre-filter

When `search_notes` receives a `filter` parameter, the tool handler computes an allowed-paths set via `listMatchingPaths(filter)` (lib/obsidian/query) and narrows the `sources` Map before invoking `executeRetrieval` / `executeMultiRetrieval`. The retrieval policy itself is unchanged — expansion, multi-query merge, and block search all operate on the narrowed Map and therefore inherit the filter for free.

Empty allowed set short-circuits to an empty result without invoking `embeddingProvider.embed` or `searchEngine`. Errors from `listMatchingPaths` map as: `INVALID_FILTER` → `INVALID_ARGUMENT`; anything else → `DEPENDENCY_ERROR`.

Path_prefix-only filters use a fast-path inside `listMatchingPaths` that calls `vaultReader.scan({ pathPrefix })` and skips frontmatter reads entirely.

## Boundaries

- The policy does not validate inputs (the tool handler does that).
- The policy does not know about MCP, error codes, or response envelopes. It returns a plain object; the layer above wraps it.
- The policy does not assume the search engine is in-memory. If a different engine is wired in, the same five-step pipeline still applies — only the cost shape changes.
- The policy does not handle structural filtering — that is a pre-step in the tool handler.
