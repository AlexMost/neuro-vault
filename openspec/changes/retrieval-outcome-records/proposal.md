Tracked by: #110 (also closes #109)

## Why

`search_notes` assembles its observability fields (`semantic_status`, `query_stats`, `truncated`) by hand on two exits, with helpers whose arguments encode which exit is calling. `query_stats` policy is testable only through the full tool. Eval still re-implements the fused pipeline, so a drift pin exists to catch the two copies diverging, and eval restates the effort-profile numbers. The pipeline module that #109 extracted already reports the semantic leg's outcome; finishing the job makes it the one owner of "which legs ran and what survived", and puts the derivation in one pure function.

## What Changes

**Leg outcome records**
- From: the pipeline returns a `SemanticLegOutcome`, a bare lexical counts object and one folded `truncated` boolean; the empty-filter case never reaches the pipeline.
- To: symmetric `semantic` / `lexical` outcome records (`skipped` | `ran` | for semantic also `failed`), each carrying its own counts and pool truncation; the top-level `truncated` means the merged cap only; an empty `allowed` set short-circuits inside the pipeline with both legs `skipped`.
- Reason: one owner for which legs ran and what survived.
- Impact: non-breaking, internal.

**One deriver, one return**
- From: `buildQueryStats` (9 fields) + `queryStatsNote` + a post-pipeline `semantic_status` override, called from two return sites.
- To: a pure `deriveObservability(outcomes, context)` producing `semantic_status`, `query_stats`, `truncated` and the degradation warning; `search_notes` keeps MCP shaping only and has one return.
- Reason: scenarios differ in records, not branches; policy becomes testable without a temp vault.
- Impact: non-breaking. Payloads byte-identical, every note sentence included.

**Eval runs the shared pipeline**
- From: `eval/pipelines.ts` calls `executeRetrieval` + `fuseRanks` itself, restates the effort numbers, and `test/eval/production-fusion-pin.test.ts` pins the two orderings together.
- To: the fused pipeline invokes `runRetrievalPipeline`, its config reads `effort-profiles.ts`, and the pin is deleted.
- Reason: one code path needs no drift pin.
- Impact: eval metrics unchanged within noise.

**Preparatory cleanup** (separate PR): the ADR-0015 pass-throughs `readThreshold` / `readPositiveInteger` are removed and `wrapDependencyError` is shared.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hybrid-search`: adds a requirement that the observability fields derive from leg outcomes, with the missing scenario for a semantic leg that fails mid-request (null semantic counts).
- `retrieval-eval`: "Standalone library execution" says the fused pipeline invokes the shared retrieval pipeline module rather than re-assembling its legs.

## Impact

- Code: `src/modules/semantic/retrieval-pipeline.ts`, new `src/modules/semantic/search-observability.ts`, `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/tool-helpers.ts`, `get-similar-notes.ts`, `find-duplicates.ts`, `eval/pipelines.ts`, `src/modules/semantic/effort-profiles.ts` (comment).
- Tests: pure tests for the deriver and the outcome records replace through-the-tool `query_stats` / `semantic_status` policy tests; `test/eval/production-fusion-pin.test.ts` deleted.
- Docs: `docs/architecture/retrieval-policy.md`, `rank-fusion.md`, `module-structure.md`, the docs map, `eval/README.md`, `docs/guide/` mentions.
- No tool contract, dependency or config change.
