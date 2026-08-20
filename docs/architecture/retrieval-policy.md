# Retrieval Policy

How a search request becomes a ranked set of notes and blocks. This is the "policy" layer that composes the embedding pipeline, the corpus, and the search engine into the behaviour described to the LLM.

This document covers the **semantic leg** of `search_notes` only. The lexical leg (exact text matching over titles, headings, and bodies) is a separate pipeline documented in [`lexical-search.md`](./lexical-search.md). The tool handler runs both legs plus a flattened expansion leg and fuses all three into one ranked `matches[]` list — see [`rank-fusion.md`](./rank-fusion.md) for the merge mechanism. This document's `results[]`/`truncated`/`per_query_hits` outputs are a fusion **source**, not a response shape of their own.

## What it is

`src/modules/semantic/retrieval-policy.ts` exports a single function, `executeRetrieval(input)`, that runs a four-step pipeline:

1. Embed the query.
2. Find note-level neighbors, filtered by `threshold` (a hard filter when the caller supplies it; the mode default otherwise, with a one-shot fallback retry at 0.3 if that default finds nothing).
3. Find block-level neighbors (scoped to seed notes, always filtered at the internal mode default — never by the caller's `threshold`), then backfill any seed the shared pass left blockless with its own best block.
4. Optionally expand per seed by treating each top result as a new query vector, filtered by `expansionFloor` (a separate seed↔note-scale parameter — `threshold` never reaches this step).

The output is `{ results: NoteResultNode[], truncated: boolean, fallback: boolean }` — a tree where each result note carries its own `blocks[]` (section-level matches within that note) and `related[]` (per-seed expansion neighbours in deep mode). `truncated` is true when the vector search's own pool cap dropped candidates before `results[]` was sliced to `limit`, independent of the tool-level merged-list cap — see [Truncated observability](./rank-fusion.md#truncated-observability-the-1-over-fetch) in `rank-fusion.md` for how this leg-level signal folds into the tool's top-level `truncated`. `fallback` is true only when this call's semantic hits came from the 0.3 retry (Step 2) — always false for an explicit `threshold`.

## Flow

```
query
  │
  ▼
[embed] ──► query_vector
  │
  ▼
[findNeighbors threshold] ─► note results (top-K)
  │   threshold = caller's explicit value, or the mode default (0.5/0.35)
  │   (if empty AND threshold was NOT explicit AND default>0.3: retry at 0.3)
  ▼
slice(0, limit) ──► seed notes
  │
  ▼
[block search per seed note] ──► block per note
  │   ALWAYS the internal mode default — never the caller's threshold
  │   quick: threshold=0, cap=5 (engine-side)
  │   deep:  threshold=0.35 (MODE_DEFAULTS.deep.threshold, hardcoded), limit=mode
  │   (sources narrowed to seed notes — orphan blocks dropped)
  ▼
[per-seed backfill] (Step 3b) ─► starved seed gets its own best block
  │   threshold=0, limit=1, scoped to that seed's source alone
  │   (multi-query: max-similarity block across query vectors)
  ▼
[per-seed expansion] (deep only) ──► related[] per seed
  │   floor = expansionFloor (caller's value, or default 0.35) — a
  │   seed↔note scale, NOT the caller's note-score threshold
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
deep:  limit=8, threshold=0.35, expansion=on, expansionLimit=3, expansionFloor=0.35 (default)
```

- `quick` is the default — used for specific lookups where the LLM expects a small, precise answer set.
- `deep` lowers the threshold, doubles+ the limit, and turns on expansion — used for "tell me about X" exploration.
- `threshold` here is a *default*, not a hardcoded constant — the caller can override it (see Step 2). `expansionFloor` is a separate default (`DEFAULT_EXPANSION_FLOOR = 0.35`), fixed independently of mode and overridable via the caller's `expansionFloor` input — it is not part of `ModeConfig`.

At the tool boundary this axis is called `effort` (`search_notes({ effort: "quick" | "deep" })`); the tool handler passes it into the policy as `mode`, which is the internal name this document uses. (The tool-level `mode` parameter is a different axis — it selects which legs run, `hybrid | lexical`.) The LLM picks the effort based on intent; the user can override per call.

## Step 1 — Embedding

Just calls `embeddingProvider.embed(query)`. If embedding fails, the policy lets the error bubble; the tool handler wraps it as `DEPENDENCY_ERROR`.

## Step 2 — Note-level neighbors, with a default-only threshold fallback

```
explicitThreshold = input.threshold !== undefined
threshold = input.threshold ?? modeConfig.threshold
results = findNeighbors(threshold)
if results is empty AND NOT explicitThreshold AND threshold > 0.3:
    results = findNeighbors(0.3)
    fallback = results.length > 0
```

`threshold` has two distinct behaviours depending on whether the caller supplied it:

- **Explicit** (`input.threshold` is set): a **hard filter**. Notes scoring below it never become seeds, and if `findNeighbors(threshold)` returns nothing, that's the final answer — zero hits, no retry. This is deliberate: an explicit value is a promise the caller is opting out of the rescue, and a silent widening would contradict what they asked for.
- **Omitted**: the mode default applies (0.5 quick / 0.35 deep), and if that default returns nothing, the policy retries once at the fallback floor `FALLBACK_THRESHOLD = 0.3`. The fallback exists because users rarely tune the threshold, and the difference between "no results" and "weak results" is more useful than silence. The 0.3 floor stays high enough to keep results meaningful but low enough to surface weak matches the user can decide about.

`RetrievalOutput.fallback` (single-query) / `MultiRetrievalOutput.per_query_fallback` (multi-query, one entry per query) records whether *this call's* hits came from the 0.3 retry — `true` only when the retry fired and returned something, always `false` for an explicit threshold. The tool layer surfaces this per query as `semantic_fallback: true` in `query_stats` (array `query` only) — see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#query_stats-array-queries-only).

Historical note: before this split, one `threshold` value reached the note-level search, the block-evidence pass, and the expansion leg, and the 0.3 retry fired even when the caller had passed `threshold` explicitly — silently widening a filter the caller had deliberately tightened. Both are now fixed: an explicit `threshold` is honored exactly, and the fallback only ever rescues a call that used the mode default.

## Step 3 — Block-level results, scoped to seed notes, independent of `threshold`

Block search runs over the **seed notes** (the top-K from step 2), not the whole corpus. This is the source of the orphan-block guarantee: if a block's note did not make the note-level top-K, the block is not surfaced.

- `deep` mode: block search uses the **internal mode default**, `MODE_DEFAULTS.deep.threshold` (0.35), hardcoded — never the caller's `threshold`, whether explicit or defaulted — plus the mode's `limit`.
- `quick` mode: block search uses `threshold = 0` and `cap = QUICK_BLOCK_LIMIT = 5`.

Block evidence is deliberately decoupled from the note-score `threshold`: a caller who raises `threshold` to see fewer, more confident seed *notes* still gets each surviving seed's normal block evidence, not a thinner slice of it. When seed-note count is 0, block search is skipped entirely. Blocks per note are sorted by `similarity` desc with `lines[0]` as tiebreak.

### Step 3b — Per-seed backfill for starved seeds

(Named "Step 4b" in the source comments in both `executeRetrieval` and `executeMultiRetrieval`, since the code's own step numbering counts fallback-threshold as a separate step.)

The shared block pass above applies a single global limit across *all* seeds' blocks in both modes (quick's top-5 `QUICK_BLOCK_LIMIT`, deep's `limit`) — deep additionally filters at the internal 0.35 default on top of that shared cap, quick does not (`threshold: 0`). Either mechanism, alone or combined, can leave a seed with zero blocks even though the note has block embeddings: quick's shared cap may hand every one of its top-5 blocks to other seeds; deep's shared cap can do the same, and its internal-default filter can *additionally* exclude all of a seed's blocks while still admitting the seed itself at the note level. After the shared pass, every seed that ended up with zero blocks gets a second, per-seed lookup: `findBlockNeighbors` scoped to just that seed's own source, at `threshold: 0`, `limit: 1` — its single best block, regardless of how weak. For `executeMultiRetrieval`, the backfill runs once per query vector and keeps the max-similarity hit across all of them, so a multi-query seed still gets one best block, not one per query. The 1-block-per-seed backfill guarantee itself is unchanged by this split — only which threshold gates the shared pass above it changed (internal default, not the caller's `threshold`).

This makes "no `blocks[]`" mean exactly one thing: the note has no block embeddings at all. A seed that has *any* block embeddings always surfaces at least one block after this backfill — the tool layer (`search-notes.ts`) relies on this to omit the `blocks` key entirely rather than ever emitting `blocks: []` (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#output-shape)).

## Step 4 — Per-seed expansion, floored by `expansionFloor`, not `threshold`

If `expansion` is on and there are seeds, each seed gets its own `related[]` list. `computeRelatedPerSeed` asks the search engine for `perSeedLimit + seedCount` neighbours per seed (the `+ seedCount` is headroom so that if some top neighbours are themselves seeds and get filtered out, the cap can still be reached), filters out any neighbour whose path is a seed, sorts by similarity desc, and slices to `perSeedLimit`.

The similarity floor passed to `findNeighbors` for this pass is `expansionFloor = input.expansionFloor ?? DEFAULT_EXPANSION_FLOOR` (`DEFAULT_EXPANSION_FLOOR = 0.35`) — **not** `threshold`. This is a dedicated parameter (`expansion_floor` at the MCP boundary, `search_notes` only) because expansion similarity lives on a fundamentally different scale than the note-level `threshold`: `threshold` filters query↔note similarity (how well a note matches the search query), while `expansionFloor` filters seed↔note similarity (how well two notes match each other). Seed↔note similarity runs empirically 0.89–0.985 in real corpora — 0.9+ is a typical "genuinely related" value — so a query-scale value like 0.5 would be nearly a no-op here, and conversely a `threshold` tuned for query-scale filtering would say nothing useful about expansion quality. The 0.35 default reproduces exactly what default calls got before `expansionFloor` existed as a separate input (this pass used to receive `threshold` directly), so unchanged callers see byte-for-byte identical output.

Crucially, there is **no global dedup across seeds**: the same neighbour path may appear in `related[]` of multiple seeds, each carrying its own `expansion_similarity` to that parent. Neighbourhood is a pairwise property.

`related[]` items carry `{ path, expansion_similarity }` only — never the top-level `similarity` field. The two scales (query-similarity vs note-to-note similarity) are deliberately kept distinct — this is the same distinction that motivated splitting `expansionFloor` out of `threshold`.

## Multi-query

`executeMultiRetrieval(input)` runs the per-query embed + retrieval (with the same default-only threshold fallback described in Step 2) in parallel via `Promise.all`, then merges and assembles a tree-shaped output.

Merge rule for note seeds (`mergeNoteResults` → `MergedSeed[]`):

- key by `path`
- similarity is `max` across the queries that matched it
- `matched_queries: string[]` records which queries surfaced this path

After merging, seeds are sorted by similarity descending (with path tiebreak), then sliced to `limit`. `truncated` is true when either the cross-query merge itself dropped candidates (`merged.length > limit`) or any single query's own per-query pool cap overflowed before merging — each query over-fetches `limit + 1` neighbours so that overflow is observable, then slices back to `limit` before the merge runs. Either cause means "this leg's pool cap dropped something," which is exactly what the tool-level `truncated` (see [`rank-fusion.md`](./rank-fusion.md#truncated-observability-the-1-over-fetch)) needs to know about.

`per_query_hits: Record<string, number>` records each query's post-slice hit count — after that query's own `limit + 1`→`limit` overflow check, before the cross-query merge. This is the semantic half of `search_notes`'s `query_stats` (the lexical half is the lexical leg's `perQueryCounts`, documented in [`lexical-search.md`](./lexical-search.md)); see [`docs/guide/finding-notes.md`](../guide/finding-notes.md) for the response-level contract. Alongside it, `per_query_fallback: Record<string, boolean>` records, per query, whether that query's hits came from the 0.3 fallback retry — `true` only when the retry fired for that specific query (never for a query that used an explicit `threshold`, since the retry never runs at all in that case). The tool layer surfaces a `true` entry as `semantic_fallback: true` in that query's `query_stats` object; `false` entries surface as an absent key, not `semantic_fallback: false`.

Block search runs **per query** with each query's own vector, scoped to seed notes; the per-query block hits are deduped by `(path, heading, lineRange)` keeping max similarity, then bucketed under each seed and sorted by similarity desc. Deep-mode block search here uses the same hardcoded internal default as single-query (`MODE_DEFAULTS.deep.threshold`, 0.35) — never the caller's `threshold`. The NUL character is used as the in-key separator so headings containing spaces (`#Meeting Notes`) cannot collide. The same Step 3b backfill described above runs afterward, per seed, over every query vector — a starved seed keeps the single highest-similarity block found across all queries' `threshold: 0, limit: 1` lookups, not one block per query.

Per-seed expansion reuses the same `computeRelatedPerSeed` helper as single-query — no duplicated expansion logic, and the same `expansionFloor` (not `threshold`) governs it.

Output: `{ results: MultiNoteResultNode[], truncated: boolean, per_query_hits: Record<string, number>, per_query_fallback: Record<string, boolean> }`. Each `MultiNoteResultNode` extends `NoteResultNode` with `matched_queries: string[]`.

## Invariants

- Results are sorted by similarity descending; `blocks[]` per note sorted by similarity desc with `lines[0]` tiebreak; `related[]` per seed sorted by `expansion_similarity` desc with `path` tiebreak.
- Final note count is bounded by `input.limit ?? mode.limit`.
- `related[]` is bounded by `expansionLimit` (default `3`) **per seed** — total count is up to `seedCount × expansionLimit`, with duplicates allowed across seeds.
- `blocks[]` belong strictly to their parent note; orphan blocks (blocks whose note is not in `results[]`) are dropped.
- Every seed with at least one block embedding ends up with a non-empty `blocks[]`, thanks to the Step 3b backfill — a seed's `blocks[]` is empty (here, at the policy layer) only when its note has no block embeddings at all. The tool layer turns that empty array into an omitted `blocks` key (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#output-shape)).
- `similarity` lives only on direct results. `expansion_similarity` lives only on `related[]` items. They never co-occur on the same object.
- `threshold` and `limit` override the mode defaults when the caller supplies them; `expansion` and `expansionLimit` are fixed by mode and not exposed to MCP callers. `threshold` reaches only note-level seed selection (Step 2) — never block search (Step 3, always the internal mode default) and never expansion (Step 4, governed by `expansionFloor` instead). An explicit `threshold` additionally disables the 0.3 fallback retry that an omitted `threshold` gets.
- `expansionFloor` overrides `DEFAULT_EXPANSION_FLOOR` (0.35) when the caller supplies it via `expansion_floor`; it is the only input that bounds expansion similarity.

## Stale-path filtering

The Smart Connections embeddings index is keyed by note path. When a file is moved (e.g. `Tasks/foo.md` → `Archive/foo.md`) Smart Connections may not evict the old entry, so `findNeighbors` can return a path that no longer exists on disk. The MCP `search_notes`, `get_similar_notes`, and `find_duplicates` handlers post-filter results through `entry.filterExisting(paths)` and drop entries (and duplicate pairs) whose paths are missing.

That filter is one per-vault adapter (`src/lib/obsidian/existing-paths.ts`), bound to the vault root and reached from the entry the handler already holds; tests substitute it directly. See [smart-connections-corpus §Stale paths](smart-connections-corpus.md#stale-paths) for what each tool filters and why. The policy itself is unchanged — filtering happens at the handler boundary so the math layer stays pure.

## Pre-filter

When `search_notes` receives a `filter` parameter, the tool handler computes an allowed-paths set via `listMatchingPaths(filter)` (lib/obsidian/query) and narrows the `sources` Map before invoking `executeRetrieval` / `executeMultiRetrieval`. The retrieval policy itself is unchanged — expansion, multi-query merge, and block search all operate on the narrowed Map and therefore inherit the filter for free.

Empty allowed set short-circuits to an empty result without invoking `embeddingProvider.embed` or `searchEngine`. Errors from `listMatchingPaths` map as: `INVALID_FILTER` → `INVALID_ARGUMENT`; anything else → `DEPENDENCY_ERROR`.

Path_prefix-only filters use a fast-path inside `listMatchingPaths` that calls `vaultReader.scan({ pathPrefix })` and skips frontmatter reads entirely.

## Boundaries

- The policy does not validate inputs (the tool handler does that).
- The policy does not know about MCP, error codes, or response envelopes. It returns a plain object; the layer above wraps it.
- The policy does not assume the search engine is in-memory. If a different engine is wired in, the same five-step pipeline still applies — only the cost shape changes.
- The policy does not handle structural filtering — that is a pre-step in the tool handler.
