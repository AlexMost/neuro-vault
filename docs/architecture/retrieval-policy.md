# Retrieval Policy

How a search request becomes a ranked set of notes and blocks. This is the "policy" layer that composes query embedding and the corpus's similarity reads (`ICorpusReader`, [`own-corpus.md`](./own-corpus.md#the-corpus-interface)) into the behaviour described to the LLM. It runs in the session, whichever side serves the corpus ([ADR-0019](../adr/0019-embedding-storage-interface.md)): the reads go to the daemon's vault entry or to the in-process one ([`semantic-backend.md`](./semantic-backend.md)).

This document covers the **semantic leg** of `search_notes` only. The lexical leg (exact text matching over titles, headings, and bodies) is a separate pipeline documented in [`lexical-search.md`](./lexical-search.md). The lexical leg is read through an `ILexicalReader` (the daemon's vault entry by default, [`lexical-search.md`](./lexical-search.md#who-holds-the-cache)). The tool handler runs both legs plus a flattened expansion leg and fuses all three into one ranked `matches[]` list — see [`rank-fusion.md`](./rank-fusion.md) for the merge mechanism. This document's `results[]`/`truncated`/`per_query_hits`/`per_query_fallback` outputs are a fusion **source**, not a response shape of their own.

## What it is

`src/modules/semantic/retrieval-policy.ts` exports a single function, `executeRetrieval(input)`, that takes `queries: string[]` and runs one pipeline over it — there is no separate single-query entry point. A single-query call is the degenerate case of the array form: the tool handler always wraps a scalar `query` into a one-element array before calling `runRetrievalPipeline`, which hands that array to the policy unchanged (`src/modules/semantic/tools/search-notes.ts` — `queries = [normalizeQuery(input.query)]` when `input.query` is a string), and the policy itself has no branch on array length. Query arity is a surfacing concern the tool layer decides afterwards (whether `matched_queries` and `query_stats` reach the MCP response), not a retrieval-path concern.

The pipeline:

1. Embed every query (in parallel, via `Promise.all`), then find every query's note-level neighbours in one corpus read — filtered by `threshold` (a hard filter when the caller supplies it; the active profile's default for the mode otherwise, with a one-shot fallback retry at the profile's `fallback`, when it has one, one more read for every query that default left empty).
2. Merge the per-query note results into one seed list, keyed by path, then cap to `limit`.
3. Find block-level neighbours for every query in one read (scoped to the merged seed notes, always filtered at the internal mode default, the profile's `blockFloor` in deep — never by the caller's `threshold`), then backfill any seed that read left blockless with its own best block across all query vectors.
4. Optionally expand per seed (deep mode only), one read anchored on every seed's own vector, filtered by `expansionFloor` (a separate seed↔note-scale parameter, defaulting to the profile's value — `threshold` never reaches this step).

Each step is one corpus call carrying every query vector (or every seed) as an anchor, except the backfill, which is one call per starved seed. Under the daemon a search is therefore a handful of socket round trips, not one per query.

The output is `RetrievalOutput` (`retrieval-policy.ts:80-89`): `{ results: NoteResultNode[], truncated: boolean, per_query_hits: Record<string, number>, per_query_fallback: Record<string, boolean> }` — a tree where each result note carries its own `matched_queries: string[]` (which input queries surfaced it — always `[query]` for a single-query call), `blocks[]` (section-level matches within that note), and `related[]` (per-seed expansion neighbours in deep mode). `truncated` is true when candidates were dropped either by the cross-query merge cap (`limit`) or by any single query's own per-query pool cap; for one query the merge cap can never bind, so it reduces exactly to that query's pool overflow (`retrieval-policy.ts:82-85` states this directly on the type). See [Truncated observability](./rank-fusion.md#truncated-observability-the-1-over-fetch) in `rank-fusion.md` for how this leg-level signal folds into the tool's top-level `truncated`. `per_query_hits` and `per_query_fallback` carry one entry per input query — see Step 2 below.

## Flow

```
queries: string[]
  │
  ▼ (Promise.all, one embed per query)
[embed] ──► query vectors
  │
  ▼
[nearest: every query vector, threshold, limit+1, allowed] ─► note hits per query
  │   threshold = caller's explicit value, or the profile's quick/deep default
  │   (queries that came back empty, when threshold was NOT explicit AND the
  │    profile has a fallback AND the default > it: one more nearest at the
  │    fallback)
  ▼
slice(0, limit) ──► per-query neighbours (+ overflow flag)
  │
  ▼
[merge by path, similarity = max, matched_queries = union] ──► merged seeds
  │   sorted by similarity desc, path asc
  ▼
slice(0, limit) ──► seed notes
  │
  ▼
[nearestBlocks: every query vector, paths = seed notes] ──► blocks per note
  │   ALWAYS the internal mode default — never the caller's threshold
  │   quick: threshold=0, limit=5 (applied inside the corpus)
  │   deep:  threshold = the profile's deep (never the caller's), limit=mode
  │   deduped across queries by (path, heading, lineRange), keeping max similarity
  ▼
[per-seed backfill] ─► starved seed gets its own best block
  │   one nearestBlocks per starved seed: every query vector,
  │   paths=[seed], threshold=0, limit=1; keeps the max-similarity hit
  ▼
[expansion] (deep only) ──► related[] per seed
  │   one nearest with every seed as a path anchor:
  │   threshold = expansionFloor (caller's value, or the profile's) — a
  │   seed↔note scale, NOT the caller's note-score threshold;
  │   exclude = every seed, limit = perSeedLimit, allowed
  ▼
assemble tree: { path, similarity, matched_queries[], blocks[], related[] }
```

## Why it exists

The corpus reads are similarity primitives; the LLM-facing tool needs a higher-level behaviour: "if the user wants a quick lookup, give me a few high-confidence matches; if the user is exploring, cast a wider net and surface relevant paragraphs." Encoding that behaviour as a policy keeps the corpus a plain similarity store (one a hosted vector store could replace) and gives one place to tune the trade-offs.

## Modes

```
quick: limit=3, threshold=profile.quick, expansion=off
deep:  limit=8, threshold=profile.deep,  expansion=on, expansionLimit=3, expansionFloor=profile.expansionFloor (default)
```

- `quick` is the default — used for specific lookups where the LLM expects a small, precise answer set.
- `deep` doubles+ the limit and turns on expansion (on some profiles it also lowers the threshold; `harrier-270m` uses one floor for both) — used for "tell me about X" exploration.
- The mode's model-independent knobs (`limit`, `expansion`, `expansionLimit`) come from `EFFORT_PROFILES` (`effort-profiles.ts`). The similarity values do not: they depend on the embedding model's score scale, so they are read from the active profile's `similarity` record, passed to `executeRetrieval` as `input.similarity` (see [Calibration](#calibration)). `quick` and `deep` are the profile's two note-level floors, `fallback` is the optional retry floor, `blockFloor` is the deep block-evidence floor, and `expansionFloor` is a separate default, fixed independently of mode and overridable via the caller's `expansionFloor` input — it is not part of `ModeConfig`.
- `threshold` here is a *default*, not a hardcoded constant — the caller can override it (see Step 1).

At the tool boundary this axis is called `effort` (`search_notes({ effort: "quick" | "deep" })`); the tool handler passes it into the policy as `mode`, which is the internal name this document uses. (The tool-level `mode` parameter is a different axis — it selects which legs run, `hybrid | lexical`.) The LLM picks the effort based on intent; the user can override per call.

## Step 1 — Per-query embedding and note-level neighbors, with a default-only threshold fallback

`retrieval-policy.ts:136-180` runs this for every query at once:

```
query_vectors = Promise.all(queries.map(embeddingProvider.embedQuery))
hits[q] = corpus.nearest(every query vector, threshold, limit: limit+1, allowed)
empty = the queries whose hits[q] is empty
if empty is not empty AND NOT explicitThreshold AND similarity.fallback is defined AND threshold > similarity.fallback:
    retried = corpus.nearest(the vectors of `empty`, similarity.fallback, limit: limit+1, allowed)
    for q in empty: hits[q] = retried[q]; fallback[q] = hits[q].length > 0
for each query:
  overflow = hits[q].length > limit
  neighbors = hits[q].slice(0, limit)
```

`embeddingProvider.embedQuery(query)` and every corpus read are called directly, with no `try`/`catch` anywhere in this file (`retrieval-policy.ts` has none) — if any one query's embed call rejects, the surrounding `Promise.all` (`retrieval-policy.ts:142-144`) rejects too, and so does a corpus read that fails (a daemon that did not answer, a corpus that stopped serving); the whole `executeRetrieval` call throws: there is no partial result and no per-query error isolation. The policy lets that rejection bubble all the way up. Its one caller, `runRetrievalPipeline` (`retrieval-pipeline.ts`, run by `search_notes`), wraps `executeRetrieval` and the existence check in one `try` whose `catch` **degrades rather than throws**: the lexical matches are already in hand, so the call returns them with the semantic leg recorded as `failed` (carrying the error), and `deriveObservability` turns that record into the stderr warning and a `semantic_status` that describes that response ([Leg outcome records](#leg-outcome-records-and-observability) below; [`semantic-backend.md`](./semantic-backend.md#who-reads-the-state)). The lexical leg gets no such cushion: it is the leg the semantic one degrades to, so a failing reader (`LexicalSearchError`) is not caught here and `search_notes` reports it as `DEPENDENCY_ERROR`.

`threshold` and `explicitThreshold` are computed once for the whole call (`input.threshold !== undefined`), not per query — every query in the array is filtered by the same threshold value:

- **Explicit** (`input.threshold` is set): a **hard filter**. Notes scoring below it never become seeds, and if the read at `threshold` returns nothing for a given query, that's the final answer for that query — zero hits, no retry. This is deliberate: an explicit value is a promise the caller is opting out of the rescue, and a silent widening would contradict what they asked for.
- **Omitted**: the active profile's default for the mode applies (`similarity.quick` or `similarity.deep`), and if that default returns nothing *for a given query*, the policy retries once at the profile's `similarity.fallback` for that query only (the retry is skipped when the default is already at or below it). The fallback is optional per profile. Where one exists, it is there because users rarely tune the threshold, and "weak results" can be more useful than silence. `harrier-270m` has none: its floor sits just above its junk level, so a retry would refill exactly the strings the floor empties, and a query with no hit above the floor gets an honest zero from this leg (the lexical leg still runs).

Each query over-fetches `limit + 1` neighbours (`retrieval-policy.ts:147,164`) so a per-query pool overflow is observable via `neighbors.length > limit`, then is immediately sliced back to `limit` (`retrieval-policy.ts:176-177`) — `neighbors` (and therefore `per_query_hits` and the merge step below) keep exactly `limit`-bounded semantics; `overflow` is the only extra signal carried out of this step.

`per_query_hits: Record<string, number>` and `per_query_fallback: Record<string, boolean>` (built at `retrieval-policy.ts:182-187`) record, per query, the post-slice hit count and whether that query's hits came from the fallback retry — `true` only when the retry fired and returned something for that query, always `false` for an explicit threshold. `deriveObservability` surfaces a `true` entry as `semantic_fallback: true` in that query's `query_stats` object; `false` entries surface as an absent key — see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#query_stats-array-queries-only).

## Step 2 — Merge across queries and cap to `limit`

`mergeNoteResults` (`retrieval-policy.ts:97-123`) folds every query's per-query neighbor list into one seed list, keyed by path:

- key by `path`
- `similarity` is `max` across the queries that matched it
- `matched_queries: string[]` records which queries surfaced this path, in first-seen order, deduplicated

The merged list is then sorted — `[...byPath.values()].sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))` (`retrieval-policy.ts:120-122`) — and sliced to `limit` (`retrieval-policy.ts:201`). `truncated` is true when either this merge itself dropped candidates (`merged.length > limit`) or any single query's own per-query pool overflowed in Step 1 (`retrieval-policy.ts:198-200`).

### The load-bearing invariant: re-sorting an already-sorted list is idempotent

For a single query, this merge-and-cap step is a no-op in effect — the fold from two entry points to one is only sound because of this. The reasoning:

- `ShardCorpus.nearest` (`src/lib/obsidian/corpus/shard-corpus.ts`) sorts each anchor's hits with `compareNoteHits` **before** it cuts them to `limit` — so what Step 1 receives from the corpus is already sorted, and slicing a sorted array preserves its order. The daemon's corpus service answers that same list unchanged, so the order is the same whichever side serves the corpus.
- `compareNoteHits` (`src/lib/obsidian/corpus/scoring.ts`) is `right.similarity - left.similarity || compareStrings(left.path, right.path)`, and `compareStrings` is `left.localeCompare(right)` — i.e. similarity descending, path ascending on ties.
- `mergeNoteResults`'s own sort (`retrieval-policy.ts:120-122`) is `b.similarity - a.similarity || a.path.localeCompare(b.path)` — the same total order, just with the comparator's parameters named the other way round.
- Paths are unique: `mergeNoteResults` keys its output `Map<string, MergedSeed>` by `path` (`retrieval-policy.ts:100`), and the corpus's in-memory side is itself a `Map` keyed by path, so one read never names a note twice. So for a single query, every entry in the merged list has a distinct path, and the comparator never returns `0` for two distinct entries — it is a strict total order on that list, not just a partial one.

Re-applying a strict total order's own sort to a list already sorted by that order is idempotent — the merge step's sort cannot reorder anything a single query's read didn't already order the same way. That is what makes "one query" a true degenerate case of "n queries" rather than a special-cased shortcut: the multi-query merge machinery runs unconditionally, and for n=1 it provably does nothing extra.

`test/semantic/retrieval-parity.test.ts` pins the tie-break half of this: its fixture holds two notes on the same vector, the matrix asserts that both are seeded together in at least one case ("the tie is decided by path, not by luck"), and every case must equal what a frozen copy of the in-memory leg returns.

This dependency is not decoration: it is part of what an `ICorpusReader` must honour. A corpus that returned its hits in another order (a hosted store with a different tie-break, say) would make the merge step silently start reordering single-query results, since nothing in `executeRetrieval` re-derives sort order from scratch independent of what the corpus handed it.

## Step 3 — Block-level results, scoped to seed notes, independent of `threshold`

Block search runs over the **merged seed notes** from Step 2 (the top-K across all queries, capped to `limit`), not the whole corpus, and is one read carrying every query vector (`retrieval-policy.ts:205-243`). This is the source of the orphan-block guarantee: if a block's note did not make the seed set, the block is not surfaced.

- `deep` mode: block search uses the **internal mode default**, the active profile's `similarity.blockFloor` — never the caller's `threshold`, whether explicit or defaulted, and never the note floor `similarity.deep` — plus the mode's `limit`.
- `quick` mode: block search uses `threshold = 0` and `limit = QUICK_BLOCK_LIMIT = 5`.

Per-query block hits are deduped by `(path, heading, lineRange)` keeping max similarity (`retrieval-policy.ts:216-231`) — the NUL character (`\0`) is used as the in-key separator so headings containing spaces cannot collide with the line-range portion of the key. Blocks per note are then sorted by `similarity` desc with `lines[0]` as tiebreak (`retrieval-policy.ts:241-243`).

Block evidence is deliberately decoupled from the note-score `threshold` and from the note floors: a caller who raises `threshold` to see fewer, more confident seed *notes* still gets each surviving seed's normal block evidence, not a thinner slice of it, and so does a profile whose note floor sits above its block floor (`harrier-270m`: 0.45 against 0.13). When seed-note count is 0, block search is skipped entirely (`retrieval-policy.ts:209`).

### Step 3b — Per-seed backfill for starved seeds

(Named "Step 4b" in the source comments — `retrieval-policy.ts:245` — because the source's own step-comment numbering is offset from this document's: the `// Step 2` label is used twice in the source, once for the per-query fallback retry (`retrieval-policy.ts:149`, "Step 2 (per query): fallback threshold") and again for the cross-query merge (`retrieval-policy.ts:189`, "Step 2: merge seeds across queries") — so every source-comment step number after that point runs one ahead of this document's own numbering.)

The shared block read above applies a single global limit across *all* seeds' blocks in both modes (quick's top-5 `QUICK_BLOCK_LIMIT`, deep's `limit`) — deep additionally filters at the internal `deep` default on top of that shared cap, quick does not (`threshold: 0`). Either mechanism, alone or combined, can leave a seed with zero blocks even though the note has block embeddings: quick's shared cap may hand every one of its top-5 blocks to other seeds; deep's shared cap can do the same, and its internal-default filter can *additionally* exclude all of a seed's blocks while still admitting the seed itself at the note level. After the shared read, every seed that ended up with zero blocks gets a second, per-seed lookup (`retrieval-policy.ts:249-264`): one `nearestBlocks` read per starved seed, carrying every query vector, scoped to that seed alone (`paths: [seed]`) at `threshold: 0`, `limit: 1` — its single best block per query, regardless of how weak. The backfill keeps the max-similarity hit across all the query vectors (the first query wins a tie), so a multi-query seed still gets one best block, not one per query; for a single-query call this reduces to that one query's own best block. The starved seeds' reads run concurrently.

This makes "no `blocks[]`" mean exactly one thing: the note has no block embeddings at all. A seed that has *any* block embeddings always surfaces at least one block after this backfill — the tool layer (`search-notes.ts`) relies on this to omit the `blocks` key entirely rather than ever emitting `blocks: []` (see [`docs/guide/finding-notes.md`](../guide/finding-notes.md#output-shape)).

## Step 4 — Per-seed expansion, floored by `expansionFloor`, not `threshold`

If `expansion` is on and there are seeds, each seed gets its own `related[]` list (`retrieval-policy.ts:267-277`, via `computeRelatedPerSeed` at `retrieval-policy.ts:42-61`). `computeRelatedPerSeed` makes one `nearest` read with every seed as a `{ path }` anchor, so the corpus uses each seed's own vector and no vector reaches the session, with `exclude` = every seed, `limit` = `perSeedLimit` and the caller's `allowed`. Each anchor's list comes back sorted by similarity desc with path asc as tiebreak. Excluding the seeds before the limit returns exactly what asking for `perSeedLimit + seedCount` neighbours and filtering the seeds out afterwards did; a seed with no vector of its own has no neighbours.

The similarity floor of that read is `expansionFloor = input.expansionFloor ?? input.similarity.expansionFloor` — the caller's value, or the active profile's default — **not** `threshold`. This is a dedicated parameter (`expansion_floor` at the MCP boundary, `search_notes` only — the only expansion-related field in the tool's zod schema, `search-notes.ts:531`; `expansion` and `expansionLimit` stay internal, fixed by mode) because expansion similarity lives on a fundamentally different scale than the note-level `threshold`: `threshold` filters query↔note similarity (how well a note matches the search query), while `expansionFloor` filters seed↔note similarity (how well two notes match each other). The two are different measures, and on some models they sit on visibly different scales (on the measured vault, `harrier-270m`'s seed↔note median is 0.49 against 0.31 for query↔note, while `granite-97m`'s are close, 0.78 against 0.75), so a query-scale value can be nearly a no-op here, and conversely a `threshold` tuned for query-scale filtering would say nothing useful about expansion quality. The exact scale depends on the model, which is why the default is profile data and the tool description interpolates the active profile's value rather than quoting a range.

Crucially, there is **no global dedup across seeds**: the same neighbour path may appear in `related[]` of multiple seeds, each carrying its own `expansion_similarity` to that parent. Neighbourhood is a pairwise property.

`related[]` items carry `{ path, expansion_similarity }` only — never the top-level `similarity` field. The two scales (query-similarity vs note-to-note similarity) are deliberately kept distinct — this is the same distinction that motivated splitting `expansionFloor` out of `threshold`.

## Assembling the tree

The final step (`retrieval-policy.ts:279-286`) maps each capped seed to a `NoteResultNode` (`types.ts:37-47`): `{ path, similarity, matched_queries, blocks, related }`. `matched_queries` is always populated at this layer — for a single-query call it is `[query]`, since that query is the only one that could have produced the seed. Whether `matched_queries` reaches the MCP response is decided by the tool layer's `isMulti` flag (`search-notes.ts:313-321` for how `isMulti` is set, `search-notes.ts:428-441` for the conditional spread that includes it only `if (matchedQueries !== undefined)`) — a purely cosmetic decision about the response shape, made after retrieval has already finished.

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

Every similarity default is data on the active `ModelProfile` (`ModelProfile.similarity`, [`model-profiles.ts`](../../src/lib/model-profiles.ts)), because a model's similarity scale is its own: an encoder with CLS pooling and a decoder with last-token pooling do not spread their scores over the same range, so one threshold set would be wrong for most profiles. The record holds seven values, `fallback` optional, and the table shows where each is applied:

| Default | Governs | Read by |
| --- | --- | --- |
| `quick` | note-level floor at effort `quick` | `executeRetrieval` (Step 1) |
| `deep` | note-level floor at effort `deep` | `executeRetrieval` (Step 1) |
| `fallback` | the one-shot retry floor when a default finds nothing; optional, no retry without it | `executeRetrieval` (Step 1) |
| `blockFloor` | floor of the deep block-evidence pass | `executeRetrieval` (Step 3) |
| `expansionFloor` | seed↔note floor of the expansion leg | `executeRetrieval` (Step 4) |
| `similarNotes` | default `threshold` of `get_similar_notes` | `get_similar_notes` |
| `duplicates` | default `threshold` of `find_duplicates` | `find_duplicates` |

The `search_notes` descriptions for `threshold` and `expansion_floor` interpolate the active profile's `quick`, `deep`, `fallback` (or say there is no retry) and `expansionFloor`, so what the model is told matches what the server applies; `get_similar_notes` and `find_duplicates` apply `similarNotes` and `duplicates` without quoting a number. The registry test pins the ordering `quick ≥ deep`, and `deep > fallback` where a fallback exists, on every profile.

### Calibrated values

| Default | `harrier-270m` (default) | `granite-97m` | `harrier-0.6b` |
| --- | --- | --- | --- |
| `quick` | 0.45 | 0.71 | 0.25 |
| `deep` | 0.45 | 0.66 | 0.19 |
| `fallback` | — (none) | 0.65 | 0.15 |
| `blockFloor` | 0.13 | 0.66 | 0.19 |
| `expansionFloor` | 0.20 | 0.65 | 0.25 |
| `similarNotes` | 0.22 | 0.67 | 0.29 |
| `duplicates` | 0.77 | 0.90 | 0.76 |

Golden-set guards at the values the method below produced (targets: `deep_filtered_first_relevant` = 0, `quick_hit_at_3_drop` ≤ 1). `harrier-270m`'s note floors have since been recalibrated (see [Recalibration of `harrier-270m`'s note floors](#recalibration-of-harrier-270ms-note-floors)), so for it these guards describe the earlier 0.20 / 0.13:

| Guard | `harrier-270m` | `granite-97m` | `harrier-0.6b` |
| --- | --- | --- | --- |
| `deep_filtered_first_relevant` | 0 | 0 | 0 |
| `quick_hit_at_3_drop` | 0 | 0 | 0 |

### Method

The thresholds were set so that each profile treats the same share of the vault as related that the bge-micro-v2 defaults did on the bge-micro-v2 scale, then checked against labelled queries. The full rationale is design decision D11 of the `embedding-model-profiles` change; the aggregates behind the table are in `openspec/changes/archive/2026-10-13-embedding-model-profiles/calibration.md`, and the decision is recorded in [ADR-0017](../adr/0017-embedding-model-profiles.md).

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

`blockFloor` was split out of `deep` without a measurement of its own: each profile's value is the `deep` it had before the split. `--stats` does not measure it, since it collects no query↔block population.

### Recalibration of `harrier-270m`'s note floors

The method above matched pass rates against bge-micro-v2, which says nothing about noise. On the extended golden set (80 entries, 17 of them control queries the vault cannot answer), `harrier-270m` at 0.20 / 0.13 with its 0.05 fallback returned notes for every control at both efforts: every control's semantic top-1 scored 0.32–0.56, above both floors. The `semantic-floor-recalibration` change (decided on issue #222, with #224) replaced its note floors:

- `quick` and `deep` are both 0.45, the value at which controls returning anything drop from 17 to 6 at both efforts while quick hit@3 holds. It was chosen on the same answerable entries it is checked on, and quick hit@3 moves within 0.905–0.937 across 0.42–0.48, so it is due a re-check when the golden set is next revised.
- The fallback is removed. With it kept, the raised floor did nothing, because the retry refilled every string the floor emptied.
- `blockFloor` keeps the old 0.13, so `blocks[]` does not thin.
- The known cost is cross-language recall. English concept queries against Ukrainian notes have relevant similarities of 0.33–0.37, the same band as English junk, so no scalar floor separates them.

`granite-97m` and `harrier-0.6b` keep the values from the method above until a change makes one of them the default and calibrates it on the same eval.

## Leg outcome records and observability

`executeRetrieval` is one leg; `runRetrievalPipeline` (`src/modules/semantic/retrieval-pipeline.ts`) runs it beside the lexical leg, fuses them ([`rank-fusion.md`](./rank-fusion.md)), and returns the fused candidates — each with its fused `score` and per-leg evidence — plus one **outcome record per leg**, the single account of which legs ran and what survived:

| Record | Variants |
| --- | --- |
| `semantic` | `skipped` (the caller opted out — `mode: "lexical"`, a non-`ready` pinned status — the vault has no corpus, or an empty allowed set, which skips both legs) · `failed` with the `error` (the leg threw; the response degrades to lexical-only) · `ran` with `perQueryHits`, `perQueryFallback` and its own pool `truncated` |
| `lexical` | `skipped` (an empty allowed set) · `ran` with `perQueryCounts`, `perQueryTokenCounts`, `totalNotes` and its own note-cap `truncated` |

The lexical record has no `failed` variant: the lexical leg is what a semantic failure degrades to, so its failure throws `LexicalSearchError` and fails the vault instead. The pipeline's top-level `truncated` is the merged cap's cut only; each leg's pool cut stays on its own record. The tool still decides whether the semantic leg should run — that is request policy — and the records report what happened given that decision.

`deriveObservability` (`src/modules/semantic/search-observability.ts`) is a pure function from those records, plus the backend status `search_notes` pinned before the legs ran, to every observability field of one vault's payload: `truncated` (the merged cut OR either leg's pool cut), `semantic_status` (the pinned status, or the status a `CorpusNotReadyError` carries when the leg failed on one, or `unavailable` for any other failure), `query_stats` for an array query (`semantic: null` whenever the semantic leg did not run), and the stderr `warning` for a failed leg. It owns `SemanticStatusField`, `QueryStatsEntry` and every note sentence, so `search_notes` makes one pipeline call, one `deriveObservability` call, and has one return. The retrieval eval harness calls the same `runRetrievalPipeline` ([`eval/README.md`](../../eval/README.md#axis-pipeline)), so a `fused` eval run measures this code path, not a copy of it.

## Stale-path filtering

The corpus is kept current by the vault entry's watcher, but only after its debounce settles and only while no reconcile is already in flight (see [`vault-entry.md`](./vault-entry.md)) — so a corpus-derived path is a claim about the index, not a promise about the filesystem. When a file is moved or deleted between reconciles, a corpus read can still return a path that no longer exists on disk. The MCP `search_notes`, `get_similar_notes`, and `find_duplicates` handlers post-filter results through `entry.filterExisting(paths)` and drop entries (and duplicate pairs) whose paths are missing.

That filter is one per-vault adapter (`src/lib/obsidian/existing-paths.ts`), bound to the vault root and reached from the entry the handler already holds; tests substitute it directly. See [`vault-registry.md`](./vault-registry.md) for how it's wired. The policy itself is unchanged — filtering happens at the handler boundary, so the corpus stays a similarity primitive with no disk access per read.

| Tool | What it filters |
| --- | --- |
| `search_notes` | semantic seeds and their flattened expansion targets, against one set. Lexical-only matches skip the check — the lexical leg's refresh stat-ed every scoped note during this request, which already proved they exist. |
| `find_duplicates` | both members of every pair; a pair with one missing member is dropped whole. |
| `get_similar_notes` | every candidate, semantic or forward-linked, after `exclude_folders` has been applied. |

## Pre-filter

When `search_notes` receives a `filter` parameter, the tool handler computes an allowed-paths set via `listMatchingPaths(filter)` (lib/obsidian/query), and `runRetrievalPipeline` passes it to `executeRetrieval` as `allowed`. The policy hands `allowed` to every `nearest` read — the seeds, the fallback retry and the expansion — and the corpus applies it to every candidate before any `limit`, so a filter can never leave a list short. Block reads need no `allowed`: they are scoped to the seeds, which already passed it.

An empty allowed set short-circuits inside `runRetrievalPipeline` to an empty result with both legs recorded as `skipped`, without invoking `embeddingProvider.embedQuery`, any corpus read or the lexical reader. Errors from `listMatchingPaths` map as: `INVALID_FILTER` → `INVALID_ARGUMENT`; anything else → `DEPENDENCY_ERROR`.

Path_prefix-only filters use a fast-path inside `listMatchingPaths` that calls `vaultReader.scan({ pathPrefix })` and skips frontmatter reads entirely. The paths that scan returns are already scope-filtered — every result runs through the vault's `VaultScope.isExcluded` predicate, prefixed scans included — so the fast-path needs no exclusion logic of its own. See [`vault-scope.md`](vault-scope.md).

## Boundaries

- The policy does not validate inputs (the tool handler does that).
- The policy does not know about MCP, error codes, or response envelopes. It returns a plain object; the layer above wraps it.
- The policy does not assume the corpus is in memory or in this process. It reads through `ICorpusReader` — a view over the vault's client, served by the daemon's vault entry or the in-process one, and a hosted store would be one more implementation — and the same pipeline applies to each; only the cost shape changes.
- The policy does not handle structural filtering — that is a pre-step in the tool handler.
