Parallelism: groups 1 → 2 → 3 → 4 are sequential (each rewrites files the next one reads). Inside group 2, tasks 2.1 and 2.2 are parallel-safe (different files, no shared state); 2.3 needs both. Group 5 tasks are parallel-safe with each other once group 4 lands.

## 1. Preparatory PR — ADR-0015 pass-throughs (direct, `Refs #110`)

- [x] 1.1 Gate-routed tests pin the schema bounds of `search_notes` (`expansion_floor`, `limit`), `get_similar_notes` (`threshold`, `limit`) and `find_duplicates` (`threshold`)
- [x] 1.2 Remove `readThreshold` / `readPositiveInteger` and read the validated value (or its default) at their six call sites
- [x] 1.3 One `wrapDependencyError` in `src/modules/semantic/tool-helpers.ts` (passing `ToolHandlerError` and `CorpusNotReadyError` through) serves `search_notes`, `get_similar_notes` and `find_duplicates`

## 2. Outcome records and the deriver (foundation PR, `Refs #110`)

- [x] 2.1 Pipeline outcome records: the lexical outcome (`skipped | ran` with counts, token counts, `totalNotes`, pool `truncated`), the semantic `ran` record gains its pool `truncated`, the top-level `truncated` is the merged cap only, an empty `allowed` set short-circuits with both legs `skipped`; pure tests in `test/semantic/retrieval-pipeline.test.ts`
- [x] 2.2 `deriveObservability` in `src/modules/semantic/search-observability.ts` (owning `SemanticStatusField`, `QueryStatsEntry`, `DEGRADED_NOTES`), with pure tests asserting every note sentence verbatim in `test/semantic/search-observability.test.ts`
- [x] 2.3 `search_notes` rewired: one pipeline call, one `deriveObservability` call, one return; `ensureFresh()` before the pipeline, skipped for an empty `allowed` set; `buildQueryStats` / `queryStatsNote` / `toStatusField` gone from the tool

## 3. Replace the through-the-tool policy tests (foundation PR)

- [x] 3.1 Delete the `query_stats` / `semantic_fallback` / `semantic_status` tests in `test/semantic/tools/search-notes-hybrid.test.ts` and `search-notes.test.ts` whose subject 2.1 / 2.2 now cover; keep the wiring tests (D6)
- [x] 3.2 Through-the-tool wiring test for the new spec scenario: a failed semantic leg reports `semantic: null` per entry

## 4. Eval runs the shared pipeline (tail PR)

- [x] 4.1 `PipelineCandidate` carries the fused `score`
- [x] 4.2 `rankFused` invokes `runRetrievalPipeline` (deep, threshold 0, profile floor, cap = top-k, admit-all existence filter); `evalConfig` reads `EFFORT_PROFILES.deep` / `LEXICAL_PER_NOTE_CAP`; drop the restating comment in `effort-profiles.ts`
- [x] 4.3 Delete `test/eval/production-fusion-pin.test.ts`; adjust `test/eval/pipelines.test.ts` to the new wiring
- [x] 4.4 `npm run eval` (semantic + fused) after; compare per-query top lists with the baseline in verify.md

## 5. Docs and close-out (tail PR)

- [x] 5.1 Sweep `docs/architecture/retrieval-policy.md`, `rank-fusion.md`, `module-structure.md`, the docs map, `eval/README.md` and every `docs/guide/` mention of `assembleUnified`, the pin, `buildQueryStats` or the restated eval numbers
- [x] 5.2 verify.md, retrospective.md, `openspec archive` (specs synced), PR with `Closes #110` and `Closes #109`
