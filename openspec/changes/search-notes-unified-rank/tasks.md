## 1. Leg output extensions (per-query counts)

- [x] 1.1 Extend `executeMultiRetrieval` (src/modules/semantic/retrieval-policy.ts) to expose per-query pre-merge hit counts (post-threshold, per-query retrieval limit) alongside `results`/`truncated`; update `MultiRetrievalOutput` type; unit tests including a zero-hit query and a query whose hits are all cut by the cross-query cap.
- [x] 1.2 Extend the lexical search path (src/lib/obsidian/lexical/rank.ts + lexical-index.ts) to expose per-query pre-`noteCap` note counts; unit tests including a zero-hit query and counts unaffected by `noteCap`.

## 2. Fusion module

- [x] 2.1 Implement expansion flattening: collect per-seed neighbour sets, exclude semantic seed paths, dedupe to unique paths keeping max `expansion_similarity`, order by it; unit tests (repeat-path max, seed exclusion, empty in quick mode).
- [x] 2.2 Implement RRF fusion as a pure function next to the merge site: `Σ 1/(k + rank)` with 1-based ranks, equal weights, `k = clamp(round(sqrt(N)), 5, 60)` with N = vault note count; tie-breaks score → source count → backlink_count → path; unit tests (two-source lift over single-source top hit, k endpoints at N=25/N=2500, deterministic ordering, single-source degradation preserving source order).

## 3. search_notes integration

- [x] 3.1 Define the new output types (`matches[]` entry with `found_in`, per-source evidence fields, top-level `truncated`, optional `query_stats`) in search-notes.ts / types.ts and wire the fusion into `runSearchForEntry` for the single-query hybrid path, including entry enrichment (existence check, `backlink_count`, `vault`) and `found_in` derivation (distinct lexical match kinds).
- [ ] 3.2 Wire the multi-query path: per-leg per-query merge feeding fusion, `matched_queries` as the cross-leg union, `query_stats` from the leg count extensions (array queries only). (`matched_queries` union done; `query_stats` deferred to Task 5.)
- [x] 3.3 Implement merged-cap semantics: effort defaults (quick 5, deep 12), `limit` overriding in every mode, always-present `truncated`; verify degradation (`mode: "lexical"`, corpus-less vault → pure lexical order, no corpus loader call) and that multi-vault fan-out fuses per vault unchanged.
- [x] 3.4 Rewrite `SEARCH_NOTES_DESCRIPTION`: response shape, `found_in` vocabulary, invariants (no split keys, no `related[]`, evidence-presence rules), `limit`/`truncated` semantics, updated examples. (`query_stats` documentation deferred to Task 5.)

## 4. Tool-surface tests

- [x] 4.1 Update search_notes tool tests via the SDK gate (`reg.spec.inputSchema` + handler through the gate): new response shape scenarios from the delta spec — two-source entry with dual evidence, expansion-only entry, absent split keys, lexical-mode purity, filter constraining `matches[]`, fan-out shape; remove all old-shape assertions. (Dead-query `query_stats` / merge-cap-not-zeroing-stats scenarios deferred to Task 5.)

## 5. Docs

- [ ] 5.1 Update the `docs/architecture/` living doc for the search response shape (fusion mechanism, k formula, provenance vocabulary); check `docs/architecture/mcp-parameter-dictionary.md` for response-field naming collisions (`found_in`, `query_stats`, `lexical`, `expansion_similarity`) and record them if the dictionary covers response fields.

## 6. Verification

- [ ] 6.1 `npm test`, `npm run lint`, `npm run typecheck` all pass; `openspec validate --all` passes; confirm the change warrants a major release note in the PR description (breaking response shape).
