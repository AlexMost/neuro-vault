## Context

`search_notes` (src/modules/semantic/tools/search-notes.ts, `runSearchForEntry`) runs two legs and returns their outputs side by side: the semantic leg (`executeRetrieval` / `executeMultiRetrieval` in retrieval-policy.ts, ordered by similarity) and the lexical leg (`rankNotes` in src/lib/obsidian/lexical/rank.ts, ordered by tier → density → backlinks; deliberately no numeric score). A third rank source — per-seed `related[]` expansion — hangs nested inside semantic entries, with the same path allowed under multiple seeds. Nothing merges the three; a note present in two sources can hold no top-list position at all (live case 26.07.2026).

Constraints: the lexical no-score invariant must survive; `compact-tool-response-contract` (in flight) is envelope-only and does not touch result shapes, but its token-economy direction informs the shape choice; ADR-0005 (one concept = one parameter name) applies to any new response fields; consumers are MCP agents, so the response must be self-explanatory without caller-side assembly.

## Goals / Non-Goals

**Goals:**

- One ranked `matches[]` list where presence in 2+ sources lifts a note without caller-side merging.
- Per-entry provenance (`found_in`) and per-source evidence preserved, so the merged list loses none of the diagnostics the split lists had.
- `query_stats` for array queries: dead variants visible in one line.
- Merge is a pure layer over existing leg outputs — no retrieval or index rework.

**Non-Goals:**

- ML re-ranking (separate research branch), embedding/model/index changes.
- Fixing degenerate semantic similarity bands or block-score normalization.
- Frontmatter projection into search results.
- Expansion duplicate-count as an importance signal (deferred; flattening keeps max similarity only).
- Tuning the k formula against a labelled dataset (heuristic v1, isolated for revision).

## Decisions

### D1: Merge is a pure layer in `runSearchForEntry`

- **Choice**: RRF merge runs after both legs return, inside `runSearchForEntry`, on the legs' existing ordered outputs. Multi-vault fan-out is untouched (merge is per-entry).
- **Rationale**: all three sources already emit rank as array order; the failure is only that no one consumes it jointly.
- **Alternative considered**: pushing a shared rank into the retrieval policy / search engine — rejected: forces the semantic layer to know about lexical results, rework without benefit.

### D2: Rank fusion is RRF with equal source weights

- **Choice**: `score(note) = Σ_sources 1 / (k + rank_source(note))`, ranks 1-based, equal weights.
- **Rationale**: RRF is rank-only, so the lexical no-score invariant survives untouched; mechanical, no model, no inference (task-note requirement). Title-vs-body weighting already lives inside the lexical leg's tier ordering — RRF consumes that order, so per-source weights add nothing in v1.
- **Alternative considered**: weighted RRF (heavier lexical-title) — deferred; trivial extension if evidence appears. Score normalization across legs — rejected: lexical has no score by design.

### D3: k adapts to vault size

- **Choice**: `k = clamp(round(sqrt(N)), 5, 60)`, where `N` is the vault's total note count (not the post-filter count — k stays stable under `filter`). Named constant + formula in one function next to the merge.
- **Rationale**: canonical k=60 is tuned for lists of hundreds; ours are ≤10, where k=60 collapses within-source position and leaves pure source-count voting. Small vault → lists are meaningful → small k (position matters); large vault → similarity bands degenerate → larger k (source voting dominates). sqrt gives that shape with sane endpoints (N=25 → k=5, N=2500 → k=50).
- **Alternative considered**: constant k=60 — rejected (degenerate at our list sizes); k from list length — rejected: list lengths are fixed by effort, so it reduces back to a constant.

### D4: Expansion flattens to a third ranked list

- **Choice**: collect all `related[]` candidates across seeds, drop paths already present as semantic seeds, dedupe to unique paths keeping **max** `expansion_similarity`, order by it. This list is the third RRF source.
- **Rationale**: RRF needs a ranked list, not a per-seed tree. Max-similarity dedupe is the simplest defensible collapse; occurrence counting is the deferred importance signal.
- **Alternative considered**: seed-rank-discounted expansion (neighbour of seed #1 outranks neighbour of seed #8) — rejected for v1 as premature complexity.

### D5: Response shape B — one `matches[]`, split lists and `related[]` removed

- **Choice**: response is `{ matches[], truncated, query_stats? }`. Each entry: `path`, `vault`, `backlink_count`, `found_in`, plus per-source evidence — `similarity` + `blocks[]` when semantic-sourced, `lexical[]` (the note's snippet matches, ≤3, shape unchanged from today's per-note `matches[]`) when lexical-sourced, `expansion_similarity` when expansion-sourced, `matched_queries` (union across legs) for array queries. `found_in` values: `"semantic"`, `"lexical:title"`, `"lexical:heading"`, `"lexical:body"` (all distinct kinds present in the entry's evidence), `"expansion"`. `related[]` is gone — expansion competes in the merge instead; `get_similar_notes` remains the neighbour-exploration tool.
- **Rationale**: the task exists because caller-side assembly loses answers; adding a fourth merged list alongside three sources duplicates paths and keeps the disease. Dropping nested `related[]` avoids dual representation of promoted paths.
- **Alternative considered**: additive `merged[]` overlay (option A) — rejected by user; keeps assembly burden, inflates response against the recently-compacted contract direction.

### D6: `limit` caps the merged list; internal leg caps stay effort-driven

- **Choice**: default merged cap: quick → 5, deep → 12; `limit` overrides it in every mode. Internal candidate-pool caps are unchanged (semantic 3/8, lexical 5/10, expansion 3/seed, block caps as today). `truncated` is always present (both string and array queries) and true when candidates were dropped anywhere on the way to `matches[]` — by the merged cap or by the semantic or lexical leg's internal pool cap (a leg that cut its pool means more matches exist in the vault than were returned). Expansion per-seed caps are deliberately not surfaced — they would fire on nearly every deep search.
- **Rationale**: one knob for one list matches the unified shape; the old split semantics (`limit` → semantic in hybrid, lexical in lexical mode) died with the split lists. Always-present `truncated` removes a shape asymmetry while we are breaking anyway.
- **Alternative considered**: `limit` scaling internal leg caps proportionally — rejected: opaque, and candidate pools already exceed default merged caps.

### D7: `query_stats` — array queries only, pre-merge-cap counts

- **Choice**: for array queries, `query_stats: { "<query>": { semantic: n, lexical: m } }` where `n` = notes that query retrieved in the semantic leg (post-threshold, per-query retrieval limit, before cross-query merge/cap) and `m` = notes it matched in the lexical leg before `noteCap`. Omitted for single-string queries. Requires small output extensions: `executeMultiRetrieval` exposes per-query hit counts; `LexicalIndex.search` / `rankNotes` exposes per-query pre-cap counts. No ranking changes in either leg.
- **Rationale**: dead-variant detection needs counts unaffected by the merge cap — a variant whose hits were all cut is not dead. Per-query retrieval limits still bound `n`; that bounds magnitude, not the zero/non-zero signal the stat exists for.
- **Alternative considered**: deriving stats from `matched_queries` on returned entries — rejected: post-cap, exactly the false-dead failure mode.

### D8: Deterministic ordering

- **Choice**: sort by RRF score desc → source count desc → `backlink_count` desc → path asc.
- **Rationale**: reproducible output for tests and stable agent behavior; source count as first tie-break reinforces the multi-source signal RRF is built for.

### D9: Enrichment and degradation

- **Choice**: every merged entry gets the existing existence check (already covers related paths today), `backlink_count`, `vault`. Expansion-only entries carry no blocks/snippets — path, provenance, `expansion_similarity`, `backlink_count` only. `mode: "lexical"` and corpus-less vaults degrade to a single-source merge (lexical order preserved, `found_in` all-lexical); empty legs contribute nothing.
- **Rationale**: in the motivating case expansion-sourced notes co-occur with a lexical hit that brings a snippet; enriching expansion-only entries with block evidence would require re-reading notes — not worth it in v1.

## Risks / Trade-offs

- [Risk] Merged top-N hides good semantic hits that ranked low in a degenerate band → Mitigation: default merged caps (5/12) are ≥ old semantic caps (3/8); `limit` can widen; degenerate-band fix is tracked separately.
- [Risk] k heuristic mis-tuned for mid-size vaults → Mitigation: single named function, contract-invisible; retuning is a patch, not a contract change.
- [Risk] Breaking change ripples through agent prompts/docs that describe the old shape → Mitigation: major version per repo release flow; tool description rewritten in the same PR; architecture living doc updated.
- [Trade-off] Expansion-only winners are evidence-light (no snippet/blocks) → accepted: co-occurrence with lexical evidence covers the motivating case; `read_notes` is one call away.
- [Trade-off] `query_stats` semantic counts are bounded by per-query retrieval limits → accepted: the stat's job is the zero/non-zero dead-variant signal, not magnitude.
- [Trade-off] Dropping `related[]` removes ambient neighbour context from deep searches → accepted: expansion candidates now compete for top-list positions instead; `get_similar_notes` serves deliberate neighbour exploration.

## Migration Plan

1. Implement merge layer + leg count extensions behind the existing tool (single PR to `main` via `gh pr create`).
2. Rewrite `SEARCH_NOTES_DESCRIPTION` (response-shape section, invariants, examples) in the same PR — the description is part of the contract.
3. Update tests: SDK-gate tool tests for the new shape, unit tests for RRF merge (multi-source lift, tie-breaks, k formula, degradation modes), leg-output extensions.
4. Docs: architecture living doc for the search response; parameter-dictionary check for new response field names (`found_in`, `query_stats`, `lexical`, `expansion_similarity`).
5. Release: merge to `main`, then `npm run release` — **major** version (breaking response shape). No data migration; no rollback complexity beyond reverting the release.

## Open Questions

- None blocking. Deferred (tracked in brainstorm): expansion occurrence-count signal, weighted RRF, k retuning with real usage data.
