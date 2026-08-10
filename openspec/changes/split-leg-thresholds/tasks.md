# Tasks — split-leg-thresholds

## 1. Regression baseline

- [x] 1.1 Add a fixture-corpus regression test locking the default-call output (no `threshold`, no `expansion_floor`; quick and deep, single and array query) so behavior preservation is provable before any retrieval change lands

## 2. Retrieval policy (src/modules/semantic/retrieval-policy.ts)

- [x] 2.1 Restrict the Step-2 fallback retry (both `executeRetrieval` and `executeMultiRetrieval`) to run only when `threshold` was not explicitly provided; an explicit threshold that filters everything returns zero semantic hits (tests: explicit 0.99 → 0 hits; in-band value → partial filtering; default call still fallback-rescued)
- [x] 2.2 Surface fallback engagement per query from the retrieval layer (needed by 3.3) — the multi-query path must report which queries were rescued, the single-query path may expose it internally without a contract surface
- [x] 2.3 Replace the `threshold` argument to `computeRelatedPerSeed` with a dedicated `expansionFloor` (default 0.35) in both paths; user `threshold` no longer reaches the expansion leg (tests: floor 0.93 keeps the 0.9341-sim neighbour and cuts 0.9206–0.9272; floor 0.99 empties expansion; explicit `threshold` alone leaves neighbour sets unchanged)
- [x] 2.4 Decouple the deep shared block pass from user `threshold` — use the internal mode default (0.35); quick stays at 0; Step-4b backfill unchanged (test: explicit in-band threshold does not thin a surviving seed's `blocks[]`)

## 3. Tool contract (src/modules/semantic/tools/search-notes.ts)

- [x] 3.1 Add optional `expansion_floor` (0–1) to the input schema with the same tolerant numeric coercion as `threshold`, plumbed through to both retrieval paths; accepted-but-inert in `effort: "quick"` and `mode: "lexical"` — assert via `reg.spec.inputSchema` (SDK gate), not handler-direct
- [x] 3.2 Verify explicit-vs-absent `threshold` reaches retrieval unmangled (absent stays `undefined` through coercion so mode defaults + fallback apply; explicit value disables fallback)
- [x] 3.3 Emit `semantic_fallback: true` on a query's `query_stats` entry when its semantic hits came from the fallback retry; absent otherwise, including all explicit-threshold requests (SDK-gate tests for both scenarios)
- [x] 3.4 Rewrite the `threshold` line in the tool description (it currently claims "SEMANTIC LEG ONLY" with working defaults — both false today) and document `expansion_floor` with its scale (seed↔note similarity) and default

## 4. Acceptance calibration tests

- [x] 4.1 Port the 2026-08-10 calibration curve onto a test fixture: semantic band 0.77–0.80, expansion candidates 0.9206/0.9259/0.9272/0.9341 — assert the full matrix from the delta spec scenarios (threshold 0.99 → zero semantic; expansion_floor 0.93 → one survivor; expansion_floor 0.99 → none; threshold 0.93 without floor → expansion unaffected by 0.93)

## 5. Docs

- [x] 5.1 Add `expansion_floor` to `docs/architecture/mcp-parameter-dictionary.md` (ADR-0005: the name is permanent — final naming review happens here)
- [x] 5.2 Sweep all of `docs/` for threshold-semantics claims, including the model-facing guide layer (not just architecture docs), and update retrieval/search architecture pages to describe the three legs' separate floors and the default-only fallback

## 6. Verification

- [x] 6.1 `npm test`, `npm run lint`, `npm run typecheck` green; `npx openspec validate --all` passes
- [x] 6.2 Confirm the 1.1 regression test still passes unmodified (default-call output byte-for-byte identical)
