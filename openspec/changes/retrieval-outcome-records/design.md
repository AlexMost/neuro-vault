## Context

`search_notes` (`src/modules/semantic/tools/search-notes.ts`) runs a hybrid search through `runRetrievalPipeline` (`src/modules/semantic/retrieval-pipeline.ts`, extracted by #109) and then builds three observability fields on the response — `semantic_status`, `query_stats`, `truncated` — the response channel of ADR-0010. Today:

- two return sites: the empty-filter early return, which never calls the pipeline, and the success path;
- `buildQueryStats` takes 9 fields, two of them (`semanticRan`, `lexicalRan`) only to say which exit is calling; the early return passes four empty placeholders;
- after the pipeline, `semantic_status` is re-derived from the semantic outcome: a `CorpusNotReadyError` carries the status it saw, any other failure is `unavailable`;
- the pipeline returns `SemanticLegOutcome` (`skipped | failed | ran`) but a bare lexical counts object, and folds the merged-cap cut and both legs' pool cuts into one `truncated`;
- `query_stats` and `semantic_status` policy is testable only through the tool (temp vault, registry stub, embedder mock per test);
- `eval/pipelines.ts` re-assembles the fused pipeline from `executeRetrieval` + `fuseRanks`, restates the effort-profile numbers, and `test/eval/production-fusion-pin.test.ts` exists to catch drift between the two copies.

Constraints: no tool-contract change — schemas, parameter names (ADR-0005), envelope and every note sentence unchanged, payloads byte-identical; eval metrics unchanged within noise; tool tests stay gate-routed (ADR-0015); no number retuned. Other sessions own the backend, lexical, daemon, vault-entry, registry, server and CLI files, so this change touches none of them.

## Goals / Non-Goals

**Goals:**

- The pipeline is the single owner of which legs ran and what survived, through symmetric outcome records.
- One pure function derives every observability field from those records plus the status pinned up front.
- `search_notes` keeps MCP shaping only (`found_in` order, `vault` / `backlink_count` stamping, evidence fields, `matched_queries`) and has one return.
- Eval's fused pipeline runs `runRetrievalPipeline`; the drift pin is gone; eval reads the effort profiles.
- Policy tests are pure; through-the-tool tests keep only wiring.

**Non-Goals:**

- Changing any observability value or wording.
- Moving the "should the semantic leg run" decision (channel + pinned status) out of the tool.
- Changing how a lexical failure is reported (`DEPENDENCY_ERROR`, cause to stderr).
- Touching the corpus, lexical reader, daemon or vault-entry seams.

## Decisions

### D1: Outcome records

- **Choice**: `SemanticLegOutcome = { status: 'skipped' } | { status: 'failed'; error } | { status: 'ran'; perQueryHits; perQueryFallback; truncated }` and `LexicalLegOutcome = { status: 'skipped' } | { status: 'ran'; perQueryCounts; perQueryTokenCounts; totalNotes; truncated }`. `RetrievalPipelineResult = { candidates, truncated, semantic, lexical }`, where the top-level `truncated` is the merged-cap cut only.
- **Rationale**: each record says what its leg did and what it dropped; nothing about a leg lives outside its record.
- **Alternatives**: a `failed` lexical variant — rejected, see D2. Keeping one folded `truncated` — rejected: the deriver would forward a value rather than own the rule, and a leg's pool cut would stay invisible to anything reading the records.

### D2: A lexical failure still throws

- **Choice**: `runRetrievalPipeline` keeps throwing `LexicalSearchError`; the lexical outcome has no `failed` variant.
- **Rationale**: the lexical leg is the floor a semantic failure degrades to, so its failure fails the vault's search (`DEPENDENCY_ERROR`). No response is built over a failed lexical leg, so a `failed` record would carry nothing to derive and oblige every caller to rethrow it.
- **Alternatives**: `{ status: 'failed', error }` symmetric with semantic — rejected as a pass-through every caller must unwrap.

### D3: The empty-filter case is a pipeline outcome

- **Choice**: an `allowed` set of size 0 returns from `runRetrievalPipeline` before either leg: both outcomes `skipped`, `candidates: []`, `truncated: false`. The tool's early return goes. `graph.ensureFresh()` stays where it is, before the pipeline, and is skipped for an empty `allowed` set exactly as the early return skipped it.
- **Rationale**: "which legs ran" gets one owner, and the empty filter becomes records like any other scenario. `ensureFresh()` keeps its place because a refresh that throws fails the vault before any leg runs — in a fan-out that vault lands in `failed_vaults` — and moving it after the pipeline would let a vault with no candidates succeed instead (an existing fan-out test pins this). The one guard it needs is about stamping, not about which legs ran.
- **Alternatives**: keep the early return and call the deriver from it — rejected: two returns, and the tool would still decide which legs ran.

### D4: One pure deriver

- **Choice**: `deriveObservability(outcomes, context)` in `src/modules/semantic/search-observability.ts`; `outcomes = { semantic, lexical, truncated }`, `context = { pinnedStatus, queries, isMulti, fallbackThreshold, vault }`; returns `{ semantic_status, query_stats?, truncated, warning? }`.
  - `semantic_status`: the pinned status mapped (absent backend → `disabled`, `indexed`/`total` only while indexing, a `DEGRADED_NOTES` sentence for every state but `ready`); when the semantic record is `failed`, a `CorpusNotReadyError` maps the status it carries and anything else is `unavailable`.
  - `query_stats`: array queries only; `semantic` null unless the semantic record `ran`; `lexical` from the lexical record (0 when skipped); `lexical_tokens` when the leg reported them; `semantic_fallback` when the semantic record flags the query; `note` per the existing precedence, only when at least one record `ran`.
  - `truncated`: merged cap OR either record's pool cut.
  - `warning`: the stderr sentence for a `failed` semantic record, worded as today.
- **Rationale**: every field is a function of records the pipeline returns plus the status read once up front; a pure function can be tested exhaustively, and a new scenario is a new record, not a new branch.
- **Alternatives**: keep `buildQueryStats` / `queryStatsNote` and pass outcomes in — rejected by the deletion test: their interface is as wide as their implementation. The deriver calling `warn` itself — rejected: it would stop being pure; the tool writes the sentence it is handed.

### D5: Type ownership

- **Choice**: `search-observability.ts` owns `SemanticStatusField` and `QueryStatsEntry`; `search-notes.ts` imports them for `SearchNotesOutput` and re-exports `SemanticStatusField`.
- **Rationale**: the deriver never imports the tool, so there is no cycle; existing imports keep working.

### D6: Tests replace, not layer

- **Choice**: new `test/semantic/search-observability.test.ts` covers every mapping and asserts every note sentence verbatim; `test/semantic/retrieval-pipeline.test.ts` gains the outcome-record cases (lexical `ran` record, pool cuts in their records, empty-`allowed` short-circuit, pre-cap counts under a merged cap). Through-the-tool tests whose subject is that policy are deleted; wiring tests stay (one hybrid `query_stats` end-to-end, the empty-filter path, degradation paths and their stderr warning, status pinning, lexical mode not reading the corpus).
- **Rationale**: the fallback flag's correctness is pinned by `retrieval-policy.test.ts` (`per_query_fallback`), the token counts by `rank.test.ts` / `lexical-index.test.ts`; tool-level copies only re-run those over a disk rig.

### D7: Eval invokes the pipeline (PR 3)

- **Choice**: `rankFused` calls `runRetrievalPipeline({ queries: [query], effort: 'deep', semantic: true, threshold: 0, expansionFloor: profile floor, cap: EVAL_TOP_K }, { corpus, lexical, filterExisting: admit-all, embeddingProvider: returns the pre-embedded vector, similarity })` and maps candidates to `{ path, score }`. `PipelineCandidate` gains the fused `score`. `evalConfig` reads `EFFORT_PROFILES.deep` and `LEXICAL_PER_NOTE_CAP`. The pin is deleted; `retrieval-eval` "Standalone library execution" is reworded.
- **Rationale**: one code path; the report's `config` reads the same file the pipeline does, so it cannot lie.
- **Alternatives**: keep the pin as a safety net — rejected: with one path it compares a function to itself.

## Risks / Trade-offs

- [Risk] A note sentence changes by a byte during the move → Mitigation: pure tests assert every sentence verbatim, copied from today's source; the remaining through-the-tool tests still run against the tool.
- [Risk] Folding the early return into the pipeline moves `ensureFresh()` and changes which vaults fail → Mitigation: it stays before the pipeline with the early return's own condition; the fan-out `failed_vaults` test pins it (it caught exactly this move during apply).
- [Risk] Splitting `truncated` into per-record fields changes the reported boolean → Mitigation: the deriver's OR is the old expression term for term; pure tests cover each source alone and none.
- [Risk] Eval's fused ordering shifts when routed through the pipeline (existence filter, cap, pool defaults) → Mitigation: admit-all existence filter, `cap` = top-k, pool numbers from the same profile; eval before/after per-query top lists compared in verify.md.
- [Trade-off] The tool still decides whether the semantic leg should run (channel + pinned status) → accepted: that is request policy, not leg outcome; the pipeline reports what happened, given that decision.

## Migration Plan

Three PRs to `main`, each green on `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`:

1. Preparatory (`Refs #110`): ADR-0015 pass-throughs out.
2. Foundation (`Refs #110`, stacked on 1): D1–D6 plus these artifacts.
3. Tail (`Closes #110`, `Closes #109`): D7, spec sync, docs sweep, verify, retrospective, archive.

Rollback is a revert per PR; no data, config or contract changes.

## Open Questions

- Should "observability derives from leg outcome records" become an ADR? It refines how ADR-0010's response channel is assembled rather than what it carries, so this design treats it as an architecture-doc update (PR 3) unless the owner wants an ADR.
