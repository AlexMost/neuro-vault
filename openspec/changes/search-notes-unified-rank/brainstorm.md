<!--
Raw capture of superpowers:brainstorming output.
Brainstorm ran as an /opsx:explore conversation (2026-08-08) grounded in the
vault task note «Єдиний ранг у search_notes — RRF по трьох джерелах і
query_stats» plus a code read of search-notes.ts, retrieval-policy.ts and
lexical/rank.ts. Format: background → decision chain → trade-offs.
-->

# Brainstorm — unified RRF rank in `search_notes` + `query_stats`

## Background

`search_notes` returns three separately-ranked sources — `semantic_matches`,
`lexical_matches`, and per-seed `related[]` expansion — and leaves the merge to
the caller. The tool description itself declares "a note in BOTH legs is a
strong relevance signal", but that signal never materializes in result order.

Live failure case (26.07.2026, vault query about Moby dick bot research,
hybrid deep, 4-query array):

- The key note appeared in **two of three sources** (lexical title hit +
  `related[]` at 0.89 expansion similarity) and had **no position in the top
  list at all** — it was absent from `semantic_matches`.
- Six semantic hits sat in a 0.7878–0.8141 similarity band (spread 0.026) —
  effectively no ranking; top-1 was a closed April task from `Archive/`.
- One of four query variants («Мобі») matched nothing anywhere; discovering
  that required manually scanning `matched_queries` on every hit.

Code findings (explore phase):

- All three sources already produce **ordered lists**; merge can be a pure
  layer in `runSearchForEntry` (src/modules/semantic/tools/search-notes.ts)
  after both legs return. No retrieval rework needed.
- Lexical leg deliberately has no numeric score (tier/density ordering,
  rank.ts) — RRF is rank-only, so this invariant survives untouched.
- Expansion is a tree, not a list: per-seed `related[]`, same path may repeat
  under multiple seeds by design (retrieval-policy.ts `computeRelatedPerSeed`).
- `compact-tool-response-contract` (in-flight change) is envelope-only; result
  shapes are explicitly out of its scope — no conflict, but its token-economy
  spirit informed the contract decision below.

## Decision chain

**Q1 — Where does the merged rank live: retrieval rework or a layer?**
→ **A pure merge layer** in `runSearchForEntry`, between "both legs returned"
and "assemble output". Both legs and the flattened expansion list already carry
rank as array order.

**Q2 — RRF k: canonical constant or adaptive?** (user decision)
→ **Adaptive to vault size.** Canonical k=60 is tuned for lists of hundreds;
our lists are ≤10, where k=60 makes within-source rank nearly irrelevant
(pure source-count voting). User chose k derived from the number of notes in
the vault: small vault → lists are meaningful → small k (position matters);
large vault → degenerate similarity bands → larger k (source voting
dominates). Working formula: `k = clamp(round(sqrt(N)), 5, 60)` where N =
note count of the vault entry. Heuristic, tunable; captured as a named
constant + formula in one place.

**Q3 — Contract: add `merged[]` alongside (A) or replace with one unified
list (B)?** (user decision)
→ **B — replace.** One `matches[]` list, each entry carrying its provenance
(`found_in`) and per-source evidence (semantic `similarity`/`blocks`, lexical
snippets). Rationale: the task exists because "assembling it in your head is
where the answer gets lost" — option A keeps that disease and adds a fourth
list of duplicated paths, against the direction the contract was recently
compacted in. Breaking change → major version.

**Q4 — Expansion duplicate count (same path under multiple seeds) as an
importance signal?** (user decision)
→ **Defer.** Noted as plausible (duplication across seeds may indicate
centrality), consciously left out of v1 to keep the merge mechanical. The
flattening keeps max `expansion_similarity` per path; occurrence counting is a
future extension.

**Q5 — Source weights in RRF: equal or title-lexical heavier?**
→ **Equal weights in v1.** Title-vs-body distinction is already encoded
*inside* the lexical leg's ordering (tier system); RRF consumes that order.
Weighted RRF is a trivial later extension if needed.

**Q6 — `query_stats`: always or array-only? Pre- or post-cap counts?**
→ **Array-query only** (single-query stats are trivial), and counts must be
**pre-cap** — a query whose hits were all cut by the seed cap is not "dead".
Requires each leg to expose per-query hit counts alongside its results (small
output extensions, no ranking changes).

**Q7 — Fate of nested `related[]` in the response?**
→ **Dropped from the contract.** Expansion becomes an *input* to RRF: the
flattened expansion list competes in the merge, and expansion-sourced entries
carry `found_in: ["expansion"]` + `expansion_similarity`. Keeping `related[]`
nested would duplicate every promoted path (nested + top-level). Neighbour
exploration remains available via `get_similar_notes`.

## Design trade-offs accepted

- **Expansion-only winners are evidence-light**: an entry sourced only from
  expansion has no blocks and no snippet — path, provenance, similarity and
  `backlink_count` only (enrichment via existing existence-check + graph is
  cheap). Accepted: in the motivating case such notes co-occur with a lexical
  hit, which brings a snippet.
- **k formula is a heuristic**: sqrt(N) with clamps has a defensible story but
  no tuning data. Accepted; isolated so it can be revisited without contract
  impact.
- **Degenerate semantic bands are NOT fixed** by this change (explicitly out
  of scope in the task note — separate score-semantics work).
- **ML re-ranking** stays out (separate research branch:
  «Research reranker stage for search_notes»).

## Out of scope (from the task note, confirmed)

- ML re-ranker, embedding quality, model change, reindexing.
- Degenerate-ranking flag and block-score normalization.
- Frontmatter projection (`status`, `priority`) into search results.
- Expansion duplicate-count importance signal (Q4, deferred).
