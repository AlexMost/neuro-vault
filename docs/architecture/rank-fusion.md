# Rank Fusion

How `search_notes`' three rank sources — semantic, lexical, expansion — become one ranked `matches[]` list. This is the merge layer that sits **above** the two legs; it does not retrieve anything itself, only fuses orderings the legs already computed.

## What it is

`src/modules/semantic/rank-fusion.ts` exports two pure functions, both consumed by `assembleUnified` in `src/modules/semantic/tools/search-notes.ts`:

- `adaptiveK(totalNotes)` — the RRF constant `k`, sized to the vault.
- `flattenExpansion(seeds)` — collapses per-seed `related[]` into one ranked list, the third fusion source.
- `fuseRanks({ sources, totalNotes, expansionWeight? })` — reciprocal-rank-fuses the three ordered source lists into one scored, sorted list of `{ path, score, sourceCount }`.

Neither function touches the corpus, the lexical index, or the filesystem — they operate on path arrays already produced by the two legs (see [`retrieval-policy.md`](./retrieval-policy.md) for the semantic leg, [`lexical-search.md`](./lexical-search.md) for the lexical leg). `assembleUnified` calls `fuseRanks`, slices to the merged-list cap, and attaches each entry's `found_in` provenance and per-source evidence — that assembly step is documented at the tool boundary in [`docs/guide/finding-notes.md`](../guide/finding-notes.md); this file covers only the fusion mechanism itself.

## Mechanism: three ordered sources → RRF

`fuseRanks` takes exactly three ordered path lists — `sources.semantic`, `sources.lexical`, `sources.expansion` — and computes, for every path appearing in at least one of them:

```
score(path) = Σ_sources weight_source / (k + rank_source(path))
```

with **1-based** ranks. Semantic and lexical are both weighted `1` — neither is privileged over the other in the formula itself (title-vs-body weighting already lives inside the lexical leg's six-tier ordering; RRF only consumes the order that ordering produced, it does not re-weight it). Expansion is weighted `EXPANSION_WEIGHT = 0.85` by default, because it is a second-order signal: its candidates are neighbours of a semantic seed, not results of the query itself — an expansion hit answers someone else's hit, not the query. At equal weight it exactly tied the primary legs' contribution rank-for-rank (see Tie-break chain below for why that mattered) and it is a plain module constant, not a per-call default — `fuseRanks` accepts an optional `expansionWeight` to override it, but that parameter is internal to the fusion function and is not exposed as an MCP tool parameter; callers who want the shipped behavior simply omit it. A path's `sourceCount` is how many of the three lists contained it; a path present in two or three sources accumulates the sum of the corresponding weighted reciprocal ranks, which is why co-occurrence lifts a note over a single-source top hit — that is the entire point of fusing rather than showing three lists side by side. Down-weighting expansion doesn't remove it from that co-occurrence effect — it still reinforces a semantic or lexical hit it agrees with, and still fills a thin result list — it only stops it from *out-scoring* an equal-rank primary-source hit on its own.

Fusion consumes only source *ranks*. It never looks at the semantic leg's `similarity`, nor does it manufacture a numeric score for the lexical leg — the lexical no-score invariant (see `lexical-search.md`) survives the merge untouched.

## Adaptive k

```ts
const K_MIN = 5;
const K_MAX = 60;
adaptiveK(N) = clamp(round(sqrt(N)), K_MIN, K_MAX)
```

`N` is `totalNotes` — the vault's total note count from the lexical leg's scan (`LexicalIndex.search`'s `totalNotes`, i.e. `reader.scan().length`), taken **pre-filter**: a `filter` parameter narrows candidates, not `N`, so `k` stays stable regardless of how narrow a given call's `filter` is.

**Why not the canonical k=60 always:** the textbook RRF constant is tuned for lists hundreds of items long, where `1/(60+rank)` still discriminates between rank 1 and rank 50. This tool's source lists are tiny — quick effort tops out around 3-5 items per source, deep around 8-10 — and at that length `k=60` makes every reciprocal rank in a list nearly indistinguishable (`1/61` vs `1/68` vs `1/70`), which collapses fusion into pure source-count voting and throws away each leg's own internal ordering.

**The shape this buys:** small vault → short, meaningful lists → small `k` so within-source position still matters (`N=25` → `k=5`); large vault → similarity bands tend to degenerate and a leg's exact position is less trustworthy → larger `k` so source-count agreement dominates over position (`N=2500` → `k=50`). `sqrt` gives that curve with sane endpoints; the `5`/`60` clamp keeps it from going to 0 (a single-item list would otherwise dominate arbitrarily) or exceeding the canonical ceiling. This is a heuristic (design decision D3, `openspec/changes/search-notes-unified-rank/design.md`) — deliberately isolated in one named function so it can be retuned against real usage data without touching the rest of the merge or the response contract.

## Tie-break chain

Sort order for the fused list, applied in order until one comparator is decisive:

1. `score` descending — the RRF sum itself.
2. `sourceCount` descending — reinforces the multi-source signal RRF exists for: given equal scores, the note more legs agree on wins.
3. `path` ascending — final deterministic tiebreak so ordering never depends on Map/object iteration order.

`backlink_count` does not participate here. It used to be step 3, and with expansion at equal weight that step was doing far more work than "final tiebreak" implies: with `k` adaptive and large relative to these tiny lists, within-leg reciprocal ranks are nearly flat, so the semantic and expansion legs would tie *exactly* rank-for-rank whenever the lexical leg was empty — every position in the fused list then came down to the backlink step. Expansion candidates are structural hubs by construction (`flattenExpansion` keeps a neighbour's max similarity across every seed it's adjacent to, so a note near many seeds surfaces repeatedly and tends to carry more inbound links than a specific single-source hit), so that tie-break systematically favoured expansion-only hub notes over direct, on-query hits — an expansion-only note could reach `#1` with `matched_queries: []`. Down-weighting expansion (see Mechanism above) removes the exact ties that made backlinks decisive, so the biased step was dropped along with them rather than kept as now-mostly-inert machinery; `path asc` alone is sufficient to keep the chain a total order. The `backlink_count` *field* is untouched — `search_notes` and `query_notes` responses still carry it, attached by `assembleUnified` outside of fusion, for the model to use as its own signal — this is purely about what `fuseRanks` sorts by.

This chain (and everything upstream of it) is a pure function of vault state, so the same query against an unchanged vault produces a byte-for-byte identical `matches[]` every time.

## Expansion flattening

`flattenExpansion(seeds)` turns the semantic leg's per-seed `related[]` trees into the third fusion source, a single ranked list:

1. Collect every `related[]` entry across all seeds.
2. **Exclude** any path already present as a semantic seed itself — a note doesn't compete against its own neighbourhood; if it's already a semantic result, `found_in` will never contain `"expansion"` for it.
3. **Deduplicate** by path, keeping the **maximum** `expansion_similarity` seen across seeds (the same neighbour can appear under several seeds with different similarities — max wins, not sum or average; occurrence-counting expansion hits as a separate importance signal was considered and deliberately deferred).
4. **Order** the deduplicated list by that kept `expansion_similarity`, descending, with `path` ascending as tiebreak.

In `effort: "quick"` no expansion is computed at all (`related[]` is always empty), so the expansion source is empty and contributes nothing to fusion — quick-effort fusion is effectively two-source RRF over semantic and lexical alone.

## Truncated observability: the +1 over-fetch

Top-level `truncated` must be true whenever candidates were dropped **anywhere** on the way to `matches[]` — either by the merged-list cap (`fused.length > cap` in `assembleUnified`) or by a source leg's own internal pool cap, even when that leg-level drop doesn't happen to also exceed the merged cap (e.g. `mode: "lexical"` with more matches than the lexical pool cap but fewer than the merged cap). A leg's pool cap is invisible from array length alone — a leg that returns exactly `limit` items looks identical whether the true candidate count was `limit` or `limit + 50`.

The two legs detect overflow via distinct mechanisms: the semantic leg detects it by over-fetching one beyond the pool cap; the lexical leg computes the true candidate count and compares it to its cap. The semantic leg's `executeRetrieval`/`executeMultiRetrieval` request `limit + 1` neighbours and check `vectorResults.length > limit` before slicing back to `limit`; the lexical leg's `rankNotes` computes `candidates.length > opts.noteCap` before slicing to `noteCap`. Either leg's overflow folds into `legTruncated`, which `assembleUnified` ORs with the merged-cap check to produce the final `truncated`. See the semantic leg's own `RetrievalOutput.truncated` / `MultiRetrievalOutput.truncated` in [`retrieval-policy.md`](./retrieval-policy.md) and the lexical leg's `truncated` in [`lexical-search.md`](./lexical-search.md) for where each half of this signal originates.

The two causes need different fixes, which is why the tool description calls this out explicitly: merged-cap truncation is recovered by raising `limit`; a leg's pool-cap truncation is not (raising `limit` never grows a leg's internal pool) — raise `effort` to `"deep"` (larger pools, plus expansion) or narrow `query`/`filter` instead.

## Degradation modes

- **`mode: "lexical"`, or no semantic corpus available** (cold/absent index) — the semantic and expansion sources are both empty; `fuseRanks` degenerates to ordering by the lexical source's own reciprocal ranks alone, so `matches[]` preserves the lexical leg's ordering exactly. Every `found_in` is lexical-only. The corpus loader is never invoked in `mode: "lexical"`.
- **Semantic leg failure or emptiness** never fails the lexical leg or the fusion — a leg contributing nothing simply doesn't contribute path entries to `fuseRanks`' input.
- **`effort: "quick"`** — expansion source is always empty (see above); fusion runs over semantic + lexical only.
- **Fan-out (multi-vault, `vault` omitted)** — fusion runs independently per vault; a vault without a semantic index still fuses (over lexical alone) rather than being skipped, matching `runFanOut`'s all-vaults contract (see [`fan-out.md`](./fan-out.md)).

## What is deliberately not here

- **Further per-source weights** — expansion now carries a real weight (`EXPANSION_WEIGHT = 0.85`, see Mechanism above), but semantic and lexical are still equal at `1`, and there is no weighting *within* a leg (e.g. a heavier lexical-title vs. lexical-body split). Each leg's own internal ordering (lexical's title>heading>body tiers, semantic's similarity) still carries that finer-grained signal instead of a second weighting layer on top. Further fusion-level weights remain deferred pending data from the retrieval eval harness — the 0.85 expansion default is itself a hand-picked start, not a tuned value, and is a candidate for the same re-tuning once that harness exists.
- **Expansion occurrence-counting** — a path appearing under multiple seeds' `related[]` currently keeps only its max similarity (see Expansion flattening above); how *many* seeds agree on it is not folded into score. Deferred as a separate importance signal, not implemented.
- **ML re-ranking** — out of scope for this merge layer entirely; a separate research thread (vault note «Research reranker stage for search_notes») explores that direction independently. This file describes only the mechanical RRF merge that ships today.
