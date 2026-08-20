## 1. Differential safety net (sequential — everything else depends on it)

Establishes the equivalence harness before any behaviour moves. Per D6 in
[`design.md`](design.md), this harness is a scratch scaffold: it is deleted in
group 5 and never committed.

- [ ] 1.1 Copy the current `executeRetrieval` body verbatim into `test/semantic/__scratch__/legacy-retrieval.ts` as `legacyExecuteRetrieval`, exporting the unchanged `RetrievalOutput` shape. No edits — this is the reference implementation.
- [ ] 1.2 Write `test/semantic/__scratch__/differential.test.ts`: for each fixture corpus already used in `retrieval-policy.test.ts`, run `legacyExecuteRetrieval({ query: q })` and `executeMultiRetrieval({ queries: [q] })` over the same inputs and assert the results agree — same paths in the same order, same `similarity`, same `blocks[]` (heading, lines, similarity), same `related[]`, and `legacy.truncated === multi.truncated`. Ignore `matched_queries`, `per_query_hits`, and `per_query_fallback` for now.
- [ ] 1.3 Run the differential test against the current, unmodified source. It MUST pass before any production code is touched — a red result here means the equivalence premise is wrong and the design needs revisiting, not the test.
- [ ] 1.4 Extend the differential fixtures to cover the cases the two suites currently assert at only one arity: fallback-threshold rescue, explicit-threshold hard filter, leg-level pool truncation (`limit + 1` overflow), per-seed block backfill for a starved seed, a seed with no block embeddings, and deep-mode expansion with a custom `expansion_floor`. Confirm still green.

## 2. Collapse the policy layer (sequential — 2.1 → 2.2 → 2.3)

- [ ] 2.1 Widen `NoteResultNode` in `src/modules/semantic/types.ts` with a required `matched_queries: string[]`, and delete `MultiNoteResultNode`. Typecheck will break at the two consumers — that is the intended signal, fixed in 2.2 and 3.1.
- [ ] 2.2 In `src/modules/semantic/retrieval-policy.ts`, rename `executeMultiRetrieval` → `executeRetrieval` and `MultiRetrievalInput`/`MultiRetrievalOutput` → `RetrievalInput`/`RetrievalOutput`, with `queries: string[]`. Drop the scalar `fallback` field per D2. Rename the old single-query function to `legacyExecuteRetrievalInSitu` temporarily so both still compile side by side; point the differential test at the renamed pair and confirm green.
- [ ] 2.3 Confirm `mergeNoteResults`, the block-key dedup, and the per-seed backfill all reduce correctly at n=1 by re-running the group 1 fixtures. Do not delete anything yet.

## 3. Collapse the caller (sequential, depends on group 2)

- [ ] 3.1 In `src/modules/semantic/tools/search-notes.ts`, replace the `isMulti` branch at the retrieval call site (currently four `let`s across `search-notes.ts:407-437`) with a single `executeRetrieval({ queries, … })` call destructured into `const`s.
- [ ] 3.2 Delete the `isMultiNode` type guard (`search-notes.ts:154`) and simplify the `matchedQueries` computation in `assembleUnified` to read `sem.matched_queries` directly. Per D4, the `isMulti` gate around whether `matched_queries` is emitted at all stays exactly where it is.
- [ ] 3.3 Simplify `buildQueryStats`: `semanticPerQueryHits` and `semanticPerQueryFallback` are no longer `| undefined` when the semantic leg ran, since the unified pipeline always produces them. Keep the `semanticRan` parameter — the lexical-only and no-corpus paths still pass `false`.
- [ ] 3.4 Update the stale comment block at `search-notes.ts:401-406` that names both `executeRetrieval` and `executeMultiRetrieval`.

## 4. Lock the MCP contract (depends on group 3; parallel-safe with group 5)

- [ ] 4.1 Add an SDK-gate assertion in the `search_notes` tool-surface tests that a single string `query` yields matches with no `matched_queries` key and a response with no `query_stats` key. Assert against `reg.spec.inputSchema` and the registered handler, not the raw handler — the repo's testing rule.
- [ ] 4.2 Add the mirror assertion: a one-element array `query` yields `matched_queries: [q]` on every match plus a `query_stats` object with exactly one key. This is the spec's "arity changes only which fields surface" scenario.
- [ ] 4.3 Add an SDK-gate test asserting the spec's arity-invariance scenario end to end: the same query as a string and as a one-element array produce identical `matches[]` ordering, `similarity`, `blocks`, and `truncated`.

## 5. Delete and reorganize (sequential, depends on group 4)

- [ ] 5.1 Delete `legacyExecuteRetrievalInSitu` from `retrieval-policy.ts` and remove the entire `test/semantic/__scratch__/` directory. Confirm `git status` shows no scratch files staged.
- [ ] 5.2 Reorganize `test/semantic/retrieval-policy.test.ts`: replace the two top-level `describe('executeRetrieval')` / `describe('executeMultiRetrieval')` blocks with invariant-named blocks, each parameterized over `[['single', [q]], ['multi', [q1, q2]]]` via `describe.each`. Every invariant currently asserted twice must end up asserted once and exercised at both arities.
- [ ] 5.3 Keep as genuinely arity-specific only the assertions that are: cross-query seed merging, `matched_queries` union across queries, per-query fallback independence, and cross-query block-key dedup. Everything else goes in the parameterized table.
- [ ] 5.4 Confirm the reorganized file preserves coverage of every invariant the old file asserted — walk the old `describe` names as a checklist against the new ones.

## 6. Documentation sweep (parallel-safe with group 5)

Per the repo convention, sweep all of `docs/`, not just `docs/architecture/` —
an architecture-scoped grep misses the model-facing guide layer.

- [ ] 6.1 Rewrite `docs/architecture/retrieval-policy.md` to describe one pipeline. Remove the two-entry-point framing; state that the single query is the degenerate case and that `matched_queries` is always computed but conditionally surfaced.
- [ ] 6.2 Sweep `docs/guide/finding-notes.md` and `docs/architecture/rank-fusion.md` for stale two-pipeline references and fix them.
- [ ] 6.3 Grep all of `docs/` for `executeMultiRetrieval`, `MultiNoteResultNode`, and `MultiRetrievalOutput`. Any hit outside `docs/superpowers/` (frozen pre-OpenSpec record — do not edit) must be updated.
- [ ] 6.4 Verify each code claim before asserting it in the rewritten architecture doc — grep the symbol rather than trusting the design doc's description of it.

## 7. Acceptance (sequential, last)

- [ ] 7.1 Run `npm test` — all green.
- [ ] 7.2 Run `npm run lint` — clean.
- [ ] 7.3 Run `npx tsc --noEmit` — clean. Authoritative per ADR-0002; a `tsup` build alone is not sufficient because of `isolatedModules`.
- [ ] 7.4 Run `openspec validate --all` — clean.
- [ ] 7.5 Confirm the line-count claim: `retrieval-policy.ts` should lose roughly 150–180 lines. A materially smaller delta means the fold did not actually collapse the duplication and is worth investigating before opening the PR.
- [ ] 7.6 Open the PR against `main` with `gh pr create` — never push directly to `main`.

## Parallelism

- Groups 1, 2, 3 are **sequential**. Each depends on the previous one compiling and the differential harness staying green.
- Groups 4 and 6 are **parallel-safe with each other** once group 3 lands — group 4 touches only tool-surface tests, group 6 touches only `docs/`.
- Group 5 is **parallel-safe with group 6** but must follow group 4, since deleting the legacy body should happen only after the contract assertions are pinned.
- Group 7 is **sequential and last**.
