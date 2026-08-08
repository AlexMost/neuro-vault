## Why

`search_notes` returns three separately-ranked sources — `semantic_matches`, `lexical_matches`, and per-seed `related[]` — and leaves the merge to the caller. The contract itself declares that a note present in both legs is a strong relevance signal, yet that signal never materializes in result order. In a live case (26.07.2026) the key note sat in two of three sources and held no position in any top list; the semantic leg's similarity band (spread 0.026) carried no real ranking; and a dead query variant in a 4-query array was only discoverable by manually scanning `matched_queries`. Assembling the answer "in your head" is where it gets lost — the tool should do the merge.

## What Changes

**Response shape: three sources → one ranked list**

- From: `{ semantic_matches[], lexical_matches[] }`, expansion nested as `related[]` inside each semantic entry; merge left to the caller.
- To: `{ matches[] }` — a single list ranked by Reciprocal Rank Fusion (RRF) over three rank sources (semantic order, lexical order, flattened expansion order). Each entry carries provenance `found_in` (e.g. `["semantic", "lexical:title", "expansion"]`) and its per-source evidence: `similarity` + `blocks[]` when semantic, lexical snippet `matches[]` when lexical, `expansion_similarity` when expansion-sourced. `related[]` disappears from the response — expansion competes inside the merge instead of hanging off seeds (neighbour exploration remains via `get_similar_notes`).
- Reason: a note surfaced by 2+ sources must rise without caller-side assembly; a fourth "merged" list alongside the existing three would duplicate paths and re-create the assembly problem.
- Impact: **breaking** (major version). All consumers of `semantic_matches` / `lexical_matches` / `related[]` must switch to `matches[]`.

**RRF parameters**

- Equal source weights in v1 (title-vs-body is already encoded inside the lexical leg's tier ordering).
- `k` adapts to vault size instead of the canonical 60: small vault → within-source position matters; large vault → source-count voting dominates. Single named formula, isolated for later tuning.

**`query_stats` for array queries**

- From: dead query variants are invisible except by scanning `matched_queries` per hit.
- To: array-query responses carry `query_stats` — per query, pre-cap hit counts per leg — so a zero-hit variant is visible in one line.
- Reason: pre-cap because a query whose hits were all cut by the seed cap is not "dead".
- Impact: additive within the new shape; requires each leg to expose per-query counts internally.

**Out of scope** (confirmed against the task note): ML re-ranker, embedding/model/index changes, degenerate-ranking flag and block-score normalization, frontmatter projection into results, expansion duplicate-count importance signal (deferred).

## Capabilities

### New Capabilities

<!-- none — unified ranking is a requirement change to the existing hybrid-search capability -->

### Modified Capabilities

- `hybrid-search`: the symmetric two-list response requirement is replaced by a unified RRF-ranked `matches[]` with per-entry provenance and evidence; `limit` semantics move to capping the merged list; `related[]` is removed from the response; array queries gain `query_stats` with pre-cap per-leg counts.

## Impact

- Code: `src/modules/semantic/tools/search-notes.ts` (merge layer, output assembly, tool description), `src/modules/semantic/retrieval-policy.ts` (expose pre-cap per-query hit counts), `src/lib/obsidian/lexical/` (per-query pre-cap counts), types in `src/modules/semantic/types.ts`.
- Tests: search-notes tool tests via the SDK gate, retrieval-policy and lexical rank unit tests, new RRF merge unit tests.
- Docs: `docs/architecture/` living doc for the search response shape; MCP parameter dictionary check (`found_in`, `query_stats` are response fields — verify no parameter-dictionary entry needed).
- Systems: MCP clients consuming `search_notes` (breaking response change, major release). Multi-vault fan-out unaffected (merge is per-vault). `mode: "lexical"` and corpus-less vaults degrade naturally (single-source merge).
