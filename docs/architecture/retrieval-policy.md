# Retrieval Policy

How a search request becomes a ranked set of notes and blocks. This is the "policy" layer that composes the embedding pipeline, the corpus, and the search engine into the behaviour described to the LLM.

This document covers the **semantic leg** of `search_notes` only. The lexical leg (exact text matching over titles, headings, and bodies) is a separate pipeline documented in [`lexical-search.md`](./lexical-search.md). The tool handler runs both legs plus a flattened expansion leg and fuses all three into one ranked `matches[]` list — see [`rank-fusion.md`](./rank-fusion.md) for the merge mechanism. This document's `results[]`/`truncated`/`per_query_hits`/`per_query_fallback` outputs are a fusion **source**, not a response shape of their own.

## What it is

`src/modules/semantic/retrieval-policy.ts` exports a single function, `executeRetrieval(input)`, that takes `queries: string[]` and runs one pipeline over it — there is no separate single-query entry point. A single-query call is the degenerate case of the array form: the tool handler always wraps a scalar `query` into a one-element array before calling in (`src/modules/semantic/tools/search-notes.ts:312-318` — `queries = [normalizeQuery(input.query)]` when `input.query` is a string), and the policy itself has no branch on array length. Query arity is a surfacing concern the tool layer decides afterwards (whether `matched_queries` and `query_stats` reach the MCP response), not a retrieval-path concern.

The pipeline:

1. Embed every query and, per query, find note-level neighbors — filtered by `threshold` (a hard filter when the caller supplies it; the active profile's default for the mode otherwise, with a one-shot fallback retry at the profile's `fallback` if that default finds nothing) — in parallel via `Promise.all`.
2. Merge the per-query note results into one seed list, keyed by path, then cap to `limit`.
3. Find block-level neighbors per query (scoped to the merged seed notes, always filtered at the internal mode default — never by the caller's `threshold`), then backfill any seed the shared pass left blockless with its own best block across all query vectors.
4. Optionally expand per seed (deep mode only) by treating each seed as a new query vector, filtered by `expansionFloor` (a separate seed↔note-scale parameter, defaulting to the profile's value — `threshold` never reaches this step).

The output is `RetrievalOutput` (`retrieval-policy.ts:87-96`): `{ results: NoteResultNode[], truncated: boolean, per_query_hits: Record<string, number>, per_query_fallback: Record<string, boolean> }` — a tree where each result note carries its own `matched_queries: string[]` (which input queries surfaced it — always `[query]` for a single-query call), `blocks[]` (section-level matches within that note), and `related[]` (per-seed expansion neighbours in deep mode). `truncated` is true when candidates were dropped either by the cross-query merge cap (`limit`) or by any single query's own per-query pool cap; for one query the merge cap can never bind, so it reduces exactly to that query's pool overflow (`retrieval-policy.ts:89-92` states this directly on the type). See [Truncated observability](./rank-fusion.md#truncated-observability-the-1-over-fetch) in `rank-fusion.md` for how this leg-level signal folds into the tool's top-level `truncated`. `per_query_hits` and `per_query_fallback` carry one entry per input query — see Step 2 below.

## Flow

```
queries: string[]
  │
  ▼ (Promise.all, one branch per query)
[embed] ──► query_vector
  │
  ▼
[findNeighbors threshold] ─► note results, over-fetched to limit+1
  │   threshold = caller's explicit value, or the profile's quick/deep default
  │   (if empty AND threshold was NOT explicit AND default > the profile's fallback:
  │    retry at the profile's fallback)
  ▼
slice(0, limit) ──► per-query neighbors (+ overflow flag)
  │
  ▼ (join all query branches)
[merge by path, similarity = max, matched_queries = union] ──► merged seeds
  │   sorted by similarity desc, path asc
  ▼
slice(0, limit) ──► seed notes
  │
  ▼
[block search per query vector, scoped to seed notes] ──► block per note
  │   ALWAYS the internal mode default — never the caller's threshold
  │   quick: threshold=0, cap=5 (engine-side)
  │   deep:  threshold = the profile's deep (never the caller's), limit=mode
  │   (sources narrowed to seed notes — orphan blocks dropped)
  │   deduped across queries by (path, heading, lineRange), keeping max similarity
  ▼
[per-seed backfill] ─► starved seed gets its own best block
  │   threshold=0, limit=1, scoped to that seed's source alone
  │   run once per query vector; keeps the max-similarity hit across all of them
  ▼
[per-seed expansion] (deep only) ──► related[] per seed
  │   floor = expansionFloor (caller's value, or the profile's) — a
  │   seed↔note scale, NOT the caller's note-score threshold
  │   each seed asks for perSeedLimit + seedCount neighbours,
  │   filters out other seeds, sorts, slices to perSeedLimit
  ▼
assemble tree: { path, similarity, matched_queries[], blocks[], related[] }
```

## Why it exists

The search engine is pure math; the LLM-facing tool needs a higher-level behaviour: "if the user wants a quick lookup, give me a few high-confidence matches; if the user is exploring, cast a wider net and surface relevant paragraphs." Encoding that behaviour as a policy keeps the math layer simple and gives one place to tune the trade-offs.

## Modes

```
quick: limit=3, threshold=profile.quick, expansion=off
deep:  limit=8, threshold=profile.deep,  expansion=on, expansionLimit=3, expansionFloor=profile.expansionFloor (default)
```

- `quick` is the default — used for specific lookups where the LLM expects a small, precise answer set.
- `deep` lowers the threshold, doubles+ the limit, and turns on expansion — used for "tell me about X" exploration.
- The mode's model-independent knobs (`limit`, `expansion`, `expansionLimit`) come from `EFFORT_PROFILES` (`effort-profiles.ts`). The similarity values do not: they depend on the embedding model's score scale, so they are read from the active profile's `similarity` record, passed to `executeRetrieval` as `input.similarity` (see [Calibration](#calibration)). `quick` and `deep` are the profile's two note-level floors, `fallback` is the retry floor, and `expansionFloor` is a separate default, fixed independently of mode and overridable via the caller's `expansionFloor` input — it is not part of `ModeConfig`.
- `threshold` here is a *default*, not a hardcoded constant — the caller can override it (see Step 1).

At the tool boundary this axis is called `effort` (`search_notes({ effort: "quick" | "deep" })`); the tool handler passes it into the policy as `mode`, which is the internal name this document uses. (The tool-level `mode` parameter is a different axis — it selects which legs run, `hybrid | lexical`.) The LLM picks the effort based on intent; the user can override per call.

## Step 1 — Per-query embedding and note-level neighbors, with a default-only threshold fallback

`retrieval-policy.ts:149-173` runs this once per query, in parallel via `Promise.all`:

```
for each query, concurrently:
  query_vector = embeddingProvider.embedQuery(query)
  neighbors = findNeighbors(threshold, limit: limit+1)
  if neighbors is empty AND NOT explicitThreshold AND threshold > similarity.fallback:
      neighbors = findNeighbors(similarity.fallback, limit: limit+1)
      fallback = neighbors.length > 0
  overflow = neighbors.length > limit
  neighbors = neighbors.slice(0, limit)
```

`embeddingProvider.embedQuery(query)` is called directly, with no `try`/`catch` anywhere in this file (`retrieval-policy.ts` has none) — if any one query's embed call rejects, the surrounding `Promise.all` (`retrieval-policy.ts:149`) rejects too, and the whole `executeRetrieval` call throws: there is no partial result and no per-query error isolation, even though embedding itself runs per query. The policy lets that rejection bubble all the way up; what the caller does with it differs per tool. `search_notes` wraps the whole semantic leg — the snapshot read, `executeRetrieval`, and the existence check — in one `try` whose `catch` **degrades rather than throws**: the lexical matches are already in hand, so the call returns them, writes the cause to stderr, and reports `semantic_status: { state: "unavailable" }`. `get_similar_notes` and `find_duplicates` have no second leg, so there the rejection still surfaces as a `DEPENDENCY_ERROR` `ToolHandlerError` — `get_similar_notes` through its own `wrapDependencyError` (which preserves the cause), `find_duplicates` by constructing the error directly.

`threshold` and `explicitThreshold` are computed once for the whole call (`input.threshold !== undefined`), not per query — every query in the array is filtered by the same threshold value:

- **Explicit** (`input.threshold` is set): a **hard filter**. Notes scoring below it never become seeds, and if `findNeighbors(threshold)` returns nothing for a given query, that's the final answer for that query — zero hits, no retry. This is deliberate: an explicit value is a promise the caller is opting out of the rescue, and a silent widening would contradict what they asked for.
- **Omitted**: the active profile's default for the mode applies (`similarity.quick` or `similarity.deep`), and if that default returns nothing *for a given query*, the policy retries once at the profile's `similarity.fallback` for that query only (the retry is skipped when the default is already at or below it). The fallback exists because users rarely tune the threshold, and the difference between "no results" and "weak results" is more useful than silence. The floor is calibrated to stay high enough to keep results meaningful but low enough to surface weak matches the user can decide about.

Each query over-fetches `limit + 1` neighbours (`retrieval-policy.ts:156,166`) so a per-query pool overflow is observable via `neighbors.length > limit`, then is immediately sliced back to `limit` (`retrieval-policy.ts:170-171`) — `neighbors` (and therefore `per_query_hits` and the merge step below) keep exactly `limit`-bounded semantics; `overflow` is the only extra signal carried out of this step.

`per_query_hits: Record<string, number>` and `per_query_fallback: Record<string, boolean>` (built at `retrieval-policy.ts:176-181`) record, per query, the post-slice hit count and whether that query's hits came from the fallback retry — `true` only when the retry fired and returned something for that query, always `false` for an explicit threshold. The tool layer surfaces a `true` entry as `semantic_fallback: true` in that query's `query_stats` object; `false` entries surface as an absent key — see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#query_stats-array-queries-only).

## Step 2 — Merge across queries and cap to `limit`

`mergeNoteResults` (`retrieval-policy.ts:104-130`) folds every query's per-query neighbor list into one seed list, keyed by path:

- key by `path`
- `similarity` is `max` across the queries that matched it
- `matched_queries: string[]` records which queries surfaced this path, in first-seen order, deduplicated

The merged list is then sorted — `[...byPath.values()].sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))` (`retrieval-policy.ts:127-129`) — and sliced to `limit` (`retrieval-policy.ts:192-195`). `truncated` is true when either this merge itself dropped candidates (`merged.length > limit`) or any single query's own per-query pool overflowed in Step 1 (`retrieval-policy.ts:192-194`).

### The load-bearing invariant: re-sorting an already-sorted list is idempotent

For a single query, this merge-and-cap step is a no-op in effect — the fold from two entry points to one is only sound because of this. The reasoning:

- `findNeighbors` (`search-engine.ts:94-110`) builds its result list via `toSearchResults`, which ends with `results.sort(compareSearchResults)` (`search-engine.ts:89`) **before** `findNeighbors` slices to `limit` (`search-engine.ts:107,109`) — so what Step 1 receives from the engine is already sorted, and slicing a sorted array preserves its order.
- `compareSearchResults` (`search-engine.ts:26-28`) is `right.similarity - left.similarity || compareStrings(left.path, right.path)`, and `compareStrings` (`search-engine.ts:22-24`) is `left.localeCompare(right)` — i.e. similarity descending, path ascending on ties.
- `mergeNoteResults`'s own sort (`retrieval-policy.ts:127-129`) is `b.similarity - a.similarity || a.path.localeCompare(b.path)` — the same total order, just with the comparator's parameters named the other way round.
- Paths are unique: `mergeNoteResults` keys its output `Map<string, MergedSeed>` by `path` (`retrieval-policy.ts:107`), and the input `sources: Map<string, SmartSource>` is itself keyed by path. So for a single query, every entry in the merged list has a distinct path, and the comparator never returns `0` for two distinct entries — it is a strict total order on that list, not just a partial one.

Re-applying a strict total order's own sort to a list already sorted by that order is idempotent — the merge step's sort cannot reorder anything a single query's `findNeighbors` call didn't already order the same way. That is what makes "one query" a true degenerate case of "n queries" rather than a special-cased shortcut: the multi-query merge machinery runs unconditionally, and for n=1 it provably does nothing extra.

`test/semantic/search-engine.test.ts:61` (`'breaks ties deterministically and includes exact-threshold matches'`) is the test that pins the tie-break half of this: two sources with identical similarity are asserted to come back ordered by path ascending (`alpha.md` before `zeta.md`), confirming `compareSearchResults` never treats distinct paths as equal — the property this invariant depends on.

This dependency is not decoration: if a future change made `findNeighbors` order-preserving instead of similarity-sorted (or changed its tie-break), the merge step here would silently start reordering single-query results too, since nothing in `executeRetrieval` re-derives sort order from scratch independent of what the engine handed it.

## Step 3 — Block-level results, scoped to seed notes, independent of `threshold`

Block search runs over the **merged seed notes** from Step 2 (the top-K across all queries, capped to `limit`), not the whole corpus, and runs once per query vector (`retrieval-policy.ts:199-244`). This is the source of the orphan-block guarantee: if a block's note did not make the seed set, the block is not surfaced.

- `deep` mode: block search uses the **internal mode default**, the active profile's `similarity.deep` — never the caller's `threshold`, whether explicit or defaulted — plus the mode's `limit`.
- `quick` mode: block search uses `threshold = 0` and `cap = QUICK_BLOCK_LIMIT = 5`.

Per-query block hits are deduped by `(path, heading, lineRange)` keeping max similarity (`retrieval-policy.ts:221-231`) — the NUL character (`\0`) is used as the in-key separator so headings containing spaces cannot collide with the line-range portion of the key. Blocks per note are then sorted by `similarity` desc with `lines[0]` as tiebreak (`retrieval-policy.ts:242-244`).

Block evidence is deliberately decoupled from the note-score `threshold`: a caller who raises `threshold` to see fewer, more confident seed *notes* still gets each surviving seed's normal block evidence, not a thinner slice of it. When seed-note count is 0, block search is skipped entirely (`retrieval-policy.ts:201`).

### Step 3b — Per-seed backfill for starved seeds

(Named "Step 4b" in the source comments — `retrieval-policy.ts:246` — because the source's own step-comment numbering is offset from this document's: the `// Step 2` label is used twice in the source, once for the per-query fallback retry inside Step 1's `Promise.all` block (`retrieval-policy.ts:158`, "Step 2 (per query): fallback threshold") and again for the cross-query merge (`retrieval-policy.ts:183`, "Step 2: merge seeds across queries") — so every source-comment step number after that point runs one ahead of this document's own numbering.)

The shared block pass above applies a single global limit across *all* seeds' blocks in both modes (quick's top-5 `QUICK_BLOCK_LIMIT`, deep's `limit`) — deep additionally filters at the internal `deep` default on top of that shared cap, quick does not (`threshold: 0`). Either mechanism, alone or combined, can leave a seed with zero blocks even though the note has block embeddings: quick's shared cap may hand every one of its top-5 blocks to other seeds; deep's shared cap can do the same, and its internal-default filter can *additionally* exclude all of a seed's blocks while still admitting the seed itself at the note level. After the shared pass, every seed that ended up with zero blocks gets a second, per-seed lookup (`retrieval-policy.ts:249-263`): `findBlockNeighbors` scoped to just that seed's own source, at `threshold: 0`, `limit: 1` — its single best block, regardless of how weak. This backfill runs once per query vector and keeps the max-similarity hit across all of them, so a multi-query seed still gets one best block, not one per query; for a single-query call this reduces to that one query's own best block.

This makes "no `blocks[]`" mean exactly one thing: the note has no block embeddings at all. A seed that has *any* block embeddings always surfaces at least one block after this backfill — the tool layer (`search-notes.ts`) relies on this to omit the `blocks` key entirely rather than ever emitting `blocks: []` (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#output-shape)).

## Step 4 — Per-seed expansion, floored by `expansionFloor`, not `threshold`

If `expansion` is on and there are seeds, each seed gets its own `related[]` list (`retrieval-policy.ts:267-276`, via `computeRelatedPerSeed` at `retrieval-policy.ts:40-70`). `computeRelatedPerSeed` asks the search engine for `perSeedLimit + seedCount` neighbours per seed (the `+ seedCount` is headroom so that if some top neighbours are themselves seeds and get filtered out, the cap can still be reached), filters out any neighbour whose path is a seed, sorts by similarity desc with path asc as tiebreak, and slices to `perSeedLimit`.

The similarity floor passed to `findNeighbors` for this pass is `expansionFloor = input.expansionFloor ?? input.similarity.expansionFloor` — the caller's value, or the active profile's default — **not** `threshold`. This is a dedicated parameter (`expansion_floor` at the MCP boundary, `search_notes` only — the only expansion-related field in the tool's zod schema, `search-notes.ts:524`; `expansion` and `expansionLimit` stay internal, fixed by mode) because expansion similarity lives on a fundamentally different scale than the note-level `threshold`: `threshold` filters query↔note similarity (how well a note matches the search query), while `expansionFloor` filters seed↔note similarity (how well two notes match each other). Note↔note similarity runs far higher than query↔note similarity, so a query-scale value would be nearly a no-op here, and conversely a `threshold` tuned for query-scale filtering would say nothing useful about expansion quality. The exact scale depends on the model, which is why the default is profile data and the tool description interpolates the active profile's value rather than quoting a range.

Crucially, there is **no global dedup across seeds**: the same neighbour path may appear in `related[]` of multiple seeds, each carrying its own `expansion_similarity` to that parent. Neighbourhood is a pairwise property.

`related[]` items carry `{ path, expansion_similarity }` only — never the top-level `similarity` field. The two scales (query-similarity vs note-to-note similarity) are deliberately kept distinct — this is the same distinction that motivated splitting `expansionFloor` out of `threshold`.

## Assembling the tree

The final step (`retrieval-policy.ts:278-285`) maps each capped seed to a `NoteResultNode` (`types.ts:37-47`): `{ path, similarity, matched_queries, blocks, related }`. `matched_queries` is always populated at this layer — for a single-query call it is `[query]`, since that query is the only one that could have produced the seed. Whether `matched_queries` reaches the MCP response is decided by the tool layer's `isMulti` flag (`search-notes.ts:312-318` for how `isMulti` is set, `search-notes.ts:421-434` for the conditional spread that includes it only `if (matchedQueries !== undefined)`) — a purely cosmetic decision about the response shape, made after retrieval has already finished.

## Invariants

- Results are sorted by similarity descending; `blocks[]` per note sorted by similarity desc with `lines[0]` tiebreak; `related[]` per seed sorted by `expansion_similarity` desc with `path` tiebreak.
- Final note count is bounded by `input.limit ?? mode.limit`.
- `related[]` is bounded by `expansionLimit` (default `3`) **per seed** — total count is up to `seedCount × expansionLimit`, with duplicates allowed across seeds.
- `blocks[]` belong strictly to their parent note; orphan blocks (blocks whose note is not in `results[]`) are dropped.
- Every seed with at least one block embedding ends up with a non-empty `blocks[]`, thanks to the Step 3b backfill — a seed's `blocks[]` is empty (here, at the policy layer) only when its note has no block embeddings at all. The tool layer turns that empty array into an omitted `blocks` key (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#output-shape)).
- `similarity` lives only on direct results. `expansion_similarity` lives only on `related[]` items. They never co-occur on the same object.
- `matched_queries` is always populated (never omitted at the policy layer) — a single-query call yields `[query]` for every result, by construction (see "Assembling the tree" above).
- `threshold` and `limit` override the mode defaults when the caller supplies them; `expansion` and `expansionLimit` are fixed by mode and not exposed to MCP callers. `threshold` reaches only note-level seed selection (Step 1) — never block search (Step 3, always the internal mode default) and never expansion (Step 4, governed by `expansionFloor` instead). An explicit `threshold` additionally disables the fallback retry that an omitted `threshold` gets.
- `expansionFloor` overrides the active profile's `similarity.expansionFloor` when the caller supplies it via `expansion_floor`; it is the only input that bounds expansion similarity.

## Calibration

Every similarity default is data on the active `ModelProfile` (`ModelProfile.similarity`, [`model-profiles.ts`](../../src/modules/semantic/model-profiles.ts)), because a model's similarity scale is its own: an encoder with CLS pooling and a decoder with last-token pooling do not spread their scores over the same range, so one threshold set would be wrong for most profiles. The record holds six values, and each is read in exactly one place:

| Default | Governs | Read by |
| --- | --- | --- |
| `quick` | note-level floor at effort `quick` | `executeRetrieval` (Step 1) |
| `deep` | note-level floor at effort `deep`; the deep block-evidence floor | `executeRetrieval` (Steps 1 and 3) |
| `fallback` | the one-shot retry floor when a default finds nothing | `executeRetrieval` (Step 1) |
| `expansionFloor` | seed↔note floor of the expansion leg | `executeRetrieval` (Step 4) |
| `similarNotes` | default `threshold` of `get_similar_notes` | `get_similar_notes` |
| `duplicates` | default `threshold` of `find_duplicates` | `find_duplicates` |

The `search_notes` descriptions for `threshold` and `expansion_floor` interpolate the active profile's `quick`, `deep`, `fallback` and `expansionFloor`, so what the model is told matches what the server applies; `get_similar_notes` and `find_duplicates` apply `similarNotes` and `duplicates` without quoting a number. The registry test pins the ordering `quick ≥ deep > fallback` on every profile.

### Calibrated values

| Default | `harrier-270m` (default) | `granite-97m` | `harrier-0.6b` |
| --- | --- | --- | --- |
| `quick` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `deep` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `fallback` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `expansionFloor` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `similarNotes` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `duplicates` | TBD-12.1 | TBD-12.1 | TBD-12.1 |

Golden-set guards at these values (targets: `deep_filtered_first_relevant` = 0, `quick_hit_at_3_drop` ≤ 1):

| Guard | `harrier-270m` | `granite-97m` | `harrier-0.6b` |
| --- | --- | --- | --- |
| `deep_filtered_first_relevant` | TBD-12.1 | TBD-12.1 | TBD-12.1 |
| `quick_hit_at_3_drop` | TBD-12.1 | TBD-12.1 | TBD-12.1 |

### Method

The thresholds were set so that each profile treats the same share of the vault as related that the bge-micro-v2 defaults did on the bge-micro-v2 scale, then checked against labelled queries. The full rationale is design decision D11 of the `embedding-model-profiles` change; the aggregates behind the table are in `openspec/changes/embedding-model-profiles/calibration.md`, and the decision is recorded in [ADR-0017](../adr/0017-embedding-model-profiles.md).

1. **Baseline on unranked populations.** A pass rate is only informative on a population that holds pairs a user never sees as well as those they do, so a threshold has something to cut. Each default is matched on its own population:

   | Default | Population |
   | --- | --- |
   | `quick`, `deep`, `fallback` | each golden query's similarity to every note with a vector |
   | `expansionFloor` | each seed against every note that is not one of that query's seeds |
   | `similarNotes` | every note against every other note |
   | `duplicates` | each note's maximum similarity to any other note |

2. **Match the pass rate.** For `quick`, `deep`, `similarNotes` and `duplicates`, the threshold on the new profile is the value at which the same share of the new profile's population passes as passed under the bge-micro-v2 default (92 %, 99.9 %, 99.97 % and 67 % of their populations). It is rounded **down** to two decimals, and `quick ≥ deep > fallback` is enforced.
3. **Floors that cut nothing.** On bge-micro-v2, `fallback` and `expansionFloor` pass 100 % of their populations: both sit below every pair on the calibration vault, so there is no pass rate to match. Each is set just below the minimum of its own unranked population on that profile, rounded down to 0.05, and `fallback` steps down a further 0.05 when the rounded value is not below `deep`.
4. **Golden-set guards.** With the new `deep`, no first-relevant hit that threshold 0 finds in the deep pool may be filtered out; with the new `quick`, hit@3 stays within one query of threshold 0. The guards model a plain filter without the fallback retry, so they are conservative. A guard failure lowers the threshold until it passes.

`deep` and `similarNotes` come from the far tail of their populations (the bge-micro-v2 defaults cut 0.09 % and 0.03 %), so their calibrated values rest on a few dozen and a few hundred extreme pairs and move with them. Calibration ran on a single vault with a 25-query golden set (21 `ua`, 4 `en`); another vault will see somewhat different absolute scores, which is why every default stays overridable per call (`threshold`, `expansion_floor`).

## Stale-path filtering

The corpus is kept current by the per-vault watcher, but only after its debounce settles and only while no reconcile is already in flight (see [`own-corpus.md`](./own-corpus.md) and [`semantic-backend.md`](./semantic-backend.md)) — so a corpus-derived path is a claim about the index, not a promise about the filesystem. When a file is moved or deleted between reconciles, `findNeighbors` can still return a path that no longer exists on disk. The MCP `search_notes`, `get_similar_notes`, and `find_duplicates` handlers post-filter results through `entry.filterExisting(paths)` and drop entries (and duplicate pairs) whose paths are missing.

That filter is one per-vault adapter (`src/lib/obsidian/existing-paths.ts`), bound to the vault root and reached from the entry the handler already holds; tests substitute it directly. See [`vault-registry.md`](./vault-registry.md) for how it's wired. The policy itself is unchanged — filtering happens at the handler boundary so the math layer stays pure.

| Tool | What it filters |
| --- | --- |
| `search_notes` | semantic seeds and their flattened expansion targets, against one set. Lexical-only matches skip the check — reading them from disk this request already proved they exist. |
| `find_duplicates` | both members of every pair; a pair with one missing member is dropped whole. |
| `get_similar_notes` | every candidate, semantic or forward-linked, after `exclude_folders` has been applied. |

## Pre-filter

When `search_notes` receives a `filter` parameter, the tool handler computes an allowed-paths set via `listMatchingPaths(filter)` (lib/obsidian/query) and narrows the `sources` Map before invoking `executeRetrieval`. The retrieval policy itself is unchanged — expansion, multi-query merge, and block search all operate on the narrowed Map and therefore inherit the filter for free.

Empty allowed set short-circuits to an empty result without invoking `embeddingProvider.embedQuery` or `searchEngine`. Errors from `listMatchingPaths` map as: `INVALID_FILTER` → `INVALID_ARGUMENT`; anything else → `DEPENDENCY_ERROR`.

Path_prefix-only filters use a fast-path inside `listMatchingPaths` that calls `vaultReader.scan({ pathPrefix })` and skips frontmatter reads entirely. The paths that scan returns are already scope-filtered — every result runs through the vault's `VaultScope.isExcluded` predicate, prefixed scans included — so the fast-path needs no exclusion logic of its own. See [`vault-scope.md`](vault-scope.md).

## Boundaries

- The policy does not validate inputs (the tool handler does that).
- The policy does not know about MCP, error codes, or response envelopes. It returns a plain object; the layer above wraps it.
- The policy does not assume the search engine is in-memory. If a different engine is wired in, the same pipeline still applies — only the cost shape changes.
- The policy does not handle structural filtering — that is a pre-step in the tool handler.
