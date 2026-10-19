# Retrieval Outcome Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runRetrievalPipeline` the single owner of which legs ran and what survived, derive every `search_notes` observability field from its outcome records in one pure function, and run eval through the same pipeline.

**Architecture:** The pipeline returns symmetric `semantic` / `lexical` outcome records plus a merged-cap `truncated`. A pure `deriveObservability` in `src/modules/semantic/search-observability.ts` turns records + the status pinned up front into `semantic_status`, `query_stats`, `truncated` and the degradation warning. `search_notes` keeps MCP shaping and has one return. Eval's fused pipeline calls the pipeline.

**Tech Stack:** TypeScript (ESM, Node ≥ 20.19), zod, vitest.

**Spec:** `design.md`, `specs/hybrid-search/spec.md` and `specs/retrieval-eval/spec.md` in this change.

## Global Constraints

- No tool-contract change: `search_notes` input/output schema, parameter names, envelope and every `query_stats` / `semantic_status` note sentence byte-identical.
- No number retuned; `FALLBACK_THRESHOLD` stays gone (the fallback note interpolates `similarity.fallback`).
- Tool tests go through `registerTool(buildXTool(deps))` + `test/_gate.ts` helpers, never `.handler` (ADR-0015).
- Do not edit `src/modules/semantic/backend/*`, `src/modules/semantic/lexical/*`, `shared-services.ts`, `daemon-embedding-provider.ts`, `src/daemon/*`, `src/lib/vault-entry/*`, `src/lib/vault-registry.ts`, `src/server.ts`, `src/lib/obsidian/corpus/*`, `src/cli*.ts`, `src/config.ts`, `package.json`, `.github/*`, `src/modules/operations/*`; keep `test/semantic/tools/_helpers.ts` changes minimal.
- Gate before every commit: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`. Conventional Commits, body lines ≤ 100 chars, one `Co-Authored-By` trailer.

## Review Focus

- A semantic leg that **fails** on an array query: `query_stats` entries must read `semantic: null` with no `semantic_fallback`, and the `note` still fires for a variant dead in the lexical leg (one leg ran). Pinned in Task 2 and Task 3.
- A `CorpusNotReadyError` failure must report the status it **carries**, not the pinned one, and not `unavailable`. Pinned in Task 2.
- An empty filter with a **string** query: no `query_stats` key at all, `truncated: false`, pinned status. Pinned in Task 2 (deriver) and the kept tool test.
- `lexical_tokens` present while the semantic leg found hits for the same query: `note` must not fire (semantic > 0 means not dead). Pinned in Task 2.
- A multi-vault fan-out: each vault derives its own fields from its own records (no shared state in the deriver). Covered by the kept fan-out `semantic_status` test.

---

### Task 1: Pipeline outcome records

**Files:**
- Modify: `src/modules/semantic/retrieval-pipeline.ts`
- Test: `test/semantic/retrieval-pipeline.test.ts`

**Interfaces:**
- Produces:
  - `type SemanticLegOutcome = { status: 'skipped' } | { status: 'failed'; error: unknown } | { status: 'ran'; perQueryHits: Record<string, number>; perQueryFallback: Record<string, boolean>; truncated: boolean }`
  - `type LexicalLegOutcome = { status: 'skipped' } | { status: 'ran'; perQueryCounts: Record<string, number>; perQueryTokenCounts: Record<string, Record<string, number>>; totalNotes: number; truncated: boolean }`
  - `interface RetrievalPipelineResult { candidates: PipelineCandidate[]; truncated: boolean /* merged cap only */; semantic: SemanticLegOutcome; lexical: LexicalLegOutcome }`

- [ ] **Step 1: Write the failing tests**
  - `it('reports the lexical leg as a ran record with its counts')` — `result.lexical` toEqual `{ status: 'ran', perQueryCounts: { quirkyterm: 2 }, perQueryTokenCounts: {}, totalNotes: 11, truncated: false }`.
  - Rewrite `'surfaces a leg pool overflow even when the merged cap is not hit'` → `result.truncated` false and `result.lexical` toMatchObject `{ status: 'ran', truncated: true }`.
  - `'cap slices the fused list and reports merged-cap truncation'` keeps `result.truncated` true; add `result.lexical.truncated` false.
  - `it('records the semantic pool cut on its own record')` — corpus with more seeds than deep's pool of 8 (11 sources), `result.semantic` toMatchObject `{ status: 'ran', truncated: true }`.
  - `it('reads neither leg over an empty allowed set')` — `allowed: new Set()`, lexical `search` spy and `embedQuery` spy not called; result toEqual `{ candidates: [], truncated: false, semantic: { status: 'skipped' }, lexical: { status: 'skipped' } }`.
  - `it('keeps pre-cap per-query counts under a merged cap of one')` — `cap: 1`, `result.semantic.perQueryHits.quirkyterm` is 8 and `result.lexical.perQueryCounts.quirkyterm` is 2.
  - Update `'fuses all three legs…'`: `result.lexical` toMatchObject `{ status: 'ran', perQueryCounts: { quirkyterm: 2 } }`.

- [ ] **Step 2: Run** `npx vitest run test/semantic/retrieval-pipeline.test.ts` — expected FAIL on the new shapes.

- [ ] **Step 3: Implement** the records in `runRetrievalPipeline`: return early on `input.allowed?.size === 0`; `truncated: fused.length > cap`; leg truncation moves into each record.

- [ ] **Step 4: Run** the file — PASS. `npx tsc --noEmit` fails only in `search-notes.ts` (fixed in Task 3; Tasks 1–3 land in one commit, since a type change ships with its call sites).

### Task 2: `deriveObservability`

**Files:**
- Create: `src/modules/semantic/search-observability.ts`
- Test: `test/semantic/search-observability.test.ts`

**Interfaces:**
- Consumes: `SemanticLegOutcome`, `LexicalLegOutcome` from Task 1; `BackendStatus`, `BackendState`, `CorpusNotReadyError` from `src/lib/obsidian/semantic-backend.ts`.
- Produces:
  - `interface SemanticStatusField { state: BackendState; indexed?: number; total?: number; note?: string }`
  - `interface QueryStatsEntry { semantic: number | null; lexical: number; lexical_tokens?: Record<string, number>; semantic_fallback?: true; note?: string }`
  - `interface LegOutcomes { semantic: SemanticLegOutcome; lexical: LexicalLegOutcome; truncated: boolean }`
  - `interface ObservabilityContext { pinnedStatus: BackendStatus | undefined; queries: string[]; isMulti: boolean; fallbackThreshold: number; vault: string }`
  - `interface Observability { semantic_status: SemanticStatusField; query_stats?: Record<string, QueryStatsEntry>; truncated: boolean; warning?: string }`
  - `function deriveObservability(outcomes: LegOutcomes, context: ObservabilityContext): Observability`

- [ ] **Step 1: Write the failing tests** (pure; records built inline, no vault). Exact sentences, copied from today's `search-notes.ts`:
  - `semantic_status`: ready → `{ state: 'ready' }` (no `note`); `undefined` → `{ state: 'disabled', note: DISABLED }`; indexing `{ indexed: 3, total: 9 }` → those counters + `INDEXING`; indexing without counters → `indexed: 0, total: 0`; unavailable → `UNAVAILABLE`; ready + `failed` with `new CorpusNotReadyError({ state: 'indexing', indexed: 1, total: 6 })` → that status + `INDEXING`; ready + `failed` with `new Error('x')` → `{ state: 'unavailable', note: UNAVAILABLE }`; a `reason` on the pinned status is never copied.
    - `INDEXING = 'The semantic leg did not run — the index is still building, so these matches are lexical-only.'`
    - `DISABLED = 'The semantic leg did not run — semantic search is turned off (for this vault, or server-wide), so these matches are lexical-only.'`
    - `UNAVAILABLE = 'The semantic leg did not run — this vault has no usable semantic index, so these matches are lexical-only.'`
  - `query_stats`: `isMulti: false` → key absent; semantic `ran` → numeric counts (missing query → 0); semantic `skipped` / `failed` → `semantic: null`, never `semantic_fallback`; lexical `skipped` → `lexical: 0`; neither ran → entries carry no `note`; dead variant without tokens → `'No hits in any leg that ran — rephrase or drop this variant.'`; dead with tokens `{ ретеншн: 0, алертів: 1 }` → `'No hits: "ретеншн" match no note alone, which kills the AND match — drop or replace it.'`; two dead tokens → `'No hits: "a", "b" match no note alone, which kills the AND match — drop or replace them.'`; all tokens alive → `'No hits: every token matches on its own but they never co-occur in one title, heading or paragraph — split this variant into separate array entries.'`; fallback with threshold 0.42 → `semantic_fallback: true` + `'Semantic hits came from the 0.42 fallback retry, so they are weaker than a normal result.'`; `lexical_tokens` present but semantic 1 → no `note`; dead-variant note outranks fallback note.
  - `truncated`: false when all three false; true for each of merged cap, lexical record, semantic record alone.
  - `warning`: `failed` with `new Error('boom')` and vault `v` → `'neuro-vault semantic: search_notes fell back to its lexical leg for vault "v": Error: boom'`; absent otherwise.

- [ ] **Step 2: Run** `npx vitest run test/semantic/search-observability.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement** the module: `DEGRADED_NOTES`, a status mapper, the note precedence and the entry builder move here from `search-notes.ts` with their comments.

- [ ] **Step 4: Run** the file — PASS.

### Task 3: `search_notes` on one return

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts`
- Test: `test/semantic/tools/search-notes.test.ts`, `test/semantic/tools/search-notes-hybrid.test.ts`

**Interfaces:**
- Consumes: Task 1's `RetrievalPipelineResult`, Task 2's `deriveObservability`, `SemanticStatusField`, `QueryStatsEntry`.
- Produces: unchanged `buildSearchNotesTool`, `SearchNotesOutput`, `UnifiedMatch`, `SemanticStatusField` (re-exported).

- [ ] **Step 1: Add the wiring test** for the new spec scenario in `search-notes.test.ts`: array query `['пошук', 'нема']`, corpus `nearest` rejects `new Error('shard broken')` → `semantic_status.state` `unavailable`, `query_stats` toEqual `{ пошук: { semantic: null, lexical: 1 }, нема: { semantic: null, lexical: 0, note: 'No hits in any leg that ran — rephrase or drop this variant.' } }`.
- [ ] **Step 2: Rewire** `runSearchForEntry`: read the status once; validate filter shape; normalize queries; compute `allowed`; one `runRetrievalPipeline` call (the `LexicalSearchError` catch unchanged); `deriveObservability(result, { pinnedStatus, queries, isMulti, fallbackThreshold: similarity.fallback, vault: entry.name })`; `warn(warning)` when present; `ensureFresh()` before the pipeline, skipped when `allowed` is empty; one return of `{ matches, truncated, semantic_status, ...query_stats }`. The semantic go/no-go still reads the pinned state (`channel !== 'lexical' && backend !== undefined && state === 'ready'`).
- [ ] **Step 3: Delete the policy tests** now pinned by Tasks 1–2: in `search-notes-hybrid.test.ts` the `query_stats` tests `omits query_stats for a string query`, both `reports pre-cap…` tests, `reports query_stats in lexical mode with semantic null`, `…when no semantic corpus is available`, `names the killer token…`, `tells an all-tokens-present query to split…`, `marks semantic hits rescued…`, `omits lexical_tokens…`, and the whole `query_stats semantic_fallback flag` describe; in `search-notes.test.ts` `reports a ready backend with no counters`, `carries no note when the backend is ready`, the `explains a %s state` table, and the `query_stats fallback note` describe. Keep every other test.
- [ ] **Step 4: Run the gate** — `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` all pass.
- [ ] **Step 5: Commit** Tasks 1–3 together: `refactor(semantic): derive search_notes observability from leg outcome records` (`Refs #110`), plus the change artifacts in their own `docs(openspec):` commit.

### Task 4: Eval runs the pipeline (tail PR)

**Files:**
- Modify: `src/modules/semantic/retrieval-pipeline.ts` (`PipelineCandidate.score: number`), `eval/pipelines.ts`, `src/modules/semantic/effort-profiles.ts` (comment)
- Delete: `test/eval/production-fusion-pin.test.ts`
- Test: `test/eval/pipelines.test.ts`, `test/semantic/retrieval-pipeline.test.ts`

- [ ] **Step 1:** Pipeline test: every candidate's `score` equals the `fuseRanks` score for its path, in descending order.
- [ ] **Step 2:** `rankFused` calls `runRetrievalPipeline` per design D7 and maps `{ path, score }`; `evalConfig` reads `EFFORT_PROFILES.deep.semanticPool` / `.expansionLimit` / `.lexicalNoteCap` and `LEXICAL_PER_NOTE_CAP`.
- [ ] **Step 3:** Delete the pin; `test/eval/pipelines.test.ts` asserts `evalConfig(TEST_SIMILARITY)` reads the profile values and the fused ranking equals `runRetrievalPipeline`'s candidate order on a fixture.
- [ ] **Step 4:** `npm run eval -- --vault <vault> --pipeline semantic` and `--pipeline fused`; compare metrics and per-query top lists with the baseline reports; record in verify.md.
- [ ] **Step 5:** Gate, commit `refactor(eval): rank the fused pipeline through runRetrievalPipeline`.

### Task 5: Docs, specs and close-out (tail PR)

- [ ] **Step 1:** `grep -rn "assembleUnified\|production-fusion-pin\|buildQueryStats\|queryStatsNote\|restates" docs eval/README.md src` → zero hits after the sweep of `docs/architecture/retrieval-policy.md`, `rank-fusion.md`, `module-structure.md`, the docs map and `docs/guide/`.
- [ ] **Step 2:** `/opsx:verify` → verify.md (eval before/after); retrospective.md; `npx openspec archive -y retrieval-outcome-records`; `openspec validate --all` passes.
- [ ] **Step 3:** PR with `Closes #110` and `Closes #109`.

## Execution

Native, in the session that wrote this plan: Tasks 1–3 share one type change and must land in one commit, and the starting brief already set the delivery order (PR 2 opens, then pause). Task 4–5 are a separate session's or a later turn's work.
