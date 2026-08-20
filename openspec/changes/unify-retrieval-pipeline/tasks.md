## 1. Differential safety net (sequential — everything depends on it)

Proves the equivalence premise against fixtures before any production code moves.
Scratch scaffolding: git-excluded, never committed, deleted in group 3.

- [x] 1.1 Copy the current single-query `executeRetrieval` body into `test/semantic/__scratch__/legacy-retrieval.ts` as `legacyExecuteRetrieval`, with a local node type so the later widening of `NoteResultNode` cannot break it.
- [x] 1.2 Write `test/semantic/__scratch__/differential.test.ts` comparing it against the multi pipeline at one query — same paths in the same order, same `similarity`, `blocks[]`, `related[]`, and `truncated`.
- [x] 1.3 Run against unmodified source. A red result means the design premise is wrong and needs revisiting, not the test.
- [x] 1.4 Give the mock engine a faithful `threshold`/`sort`/`limit`/`sources` contract, and give every case a positive precondition proving its branch genuinely ran — a case asserting `[] == []` is coverage theater.
- [x] 1.5 Mutation-check the gate: break something in the surviving pipeline, confirm RED, revert, confirm GREEN. A gate that cannot fail is not a gate.

## 2. Characterization tests for arity invariance (sequential, after group 1)

Written against the **current, unmodified** two-pipeline code and committed before
the fold, so the contract guard exists in history independent of the change it guards.

- [ ] 2.1 Add an SDK-gate `describe` to `test/semantic/tools/search-notes-hybrid.test.ts` asserting a one-element array produces the same `matches[]` ordering, `similarity`, `blocks`, and `truncated` as the equivalent string query.
- [ ] 2.2 Assert arity changes only which fields surface: a string query carries neither `matched_queries` nor `query_stats`; a one-element array carries both, and nothing else differs.
- [ ] 2.3 Assert the semantic fallback fires identically at both arities, with a precondition proving the 0.3 retry actually rescued the hit.
- [ ] 2.4 Assert the schema advertises and accepts both arities via `reg.spec.inputSchema`.
- [ ] 2.5 Run against unmodified code — they must pass. A failure is a finding: the contract already differs by arity and the refactor's premise is false. Report, do not amend the test.
- [ ] 2.6 Full suite green, then commit.

## 3. The fold (sequential, after group 2)

One atomic change. Widening a shared type, collapsing the policy layer, and
collapsing the caller are one edit — a task that cannot compile partway through
cannot be tested or reviewed, so they land together and end green.

- [ ] 3.1 Widen `NoteResultNode` with a required `matched_queries: string[]`; delete `MultiNoteResultNode`.
- [ ] 3.2 Delete the single-query `executeRetrieval`; rename `executeMultiRetrieval` → `executeRetrieval` and its input/output types, spelling out `RetrievalInput` in full. Drop the scalar `fallback` — no caller ever read it.
- [ ] 3.3 Re-point the differential harness at the renamed function and confirm 8/8 still pass. If it goes red, the rename was not a pure rename.
- [ ] 3.4 Delete the `isMultiNode` type guard; read `sem.matched_queries` directly. The `isMulti` gate around whether the field is emitted stays exactly where it is — that line is what keeps the MCP contract still.
- [ ] 3.5 Replace the four-`let` dispatch branch at the retrieval call site with one `executeRetrieval({ queries, … })` call.
- [ ] 3.6 Tighten `buildQueryStats`: the two records stop being `| undefined`; the two `semanticRan: false` call sites pass `{}, {}`.
- [ ] 3.7 Update the stale comment naming both functions.
- [ ] 3.8 Typecheck clean, and run group 2's arity tests — passing now is the evidence the contract did not move. A failure means fix the source, not the test.
- [ ] 3.9 Reorganize `test/semantic/retrieval-policy.test.ts`: each invariant asserted once, parameterized over `[single query, query array]`.
- [ ] 3.10 Keep genuinely arity-specific assertions separate: cross-query seed merging, `matched_queries` union, per-query fallback independence, cross-query block-key dedup.
- [ ] 3.11 Walk the old `describe`/`it` names as a checklist against the new ones; put it in the report. An invariant that silently vanishes during a "no behaviour change" refactor is the failure mode this catches.
- [ ] 3.12 Delete `test/semantic/__scratch__/`.
- [ ] 3.13 Full green — `npm test`, `npx tsc --noEmit`, `npm run lint` — then commit.

## 4. Documentation sweep (after group 3; parallel-safe with nothing else outstanding)

Sweeps all of `docs/`, not only `docs/architecture/` — an architecture-scoped grep
misses the model-facing guide layer.

- [ ] 4.1 Rewrite `docs/architecture/retrieval-policy.md` to describe one pipeline. Line 9 already claims the module exports a single function — false today; the rewrite makes it true rather than changing its meaning.
- [ ] 4.2 Record the load-bearing invariant: the fold is sound *because* `findNeighbors` returns results already sorted by the comparator `mergeNoteResults` re-applies, pinned by `test/semantic/search-engine.test.ts:61`.
- [ ] 4.3 Fix `docs/architecture/rank-fusion.md:68`; verify `lexical-search.md:127` and `docs/guide/finding-notes.md` (both expected to need no change — they are written at the contract level).
- [ ] 4.4 Verify every code claim written by grepping the symbol against shipped source. A claim carried from the design doc is not evidence.
- [ ] 4.5 Commit.

## 5. Acceptance and PR (sequential, last)

- [ ] 5.1 `npm test`, `npm run lint`, `npx tsc --noEmit` — all clean.
- [ ] 5.2 `openspec validate --all` — clean.
- [ ] 5.3 Confirm `retrieval-policy.ts` lost ~150–180 lines. A materially smaller delta means the duplication was not collapsed.
- [ ] 5.4 Confirm no `SearchNotesOutput` / `inputSchema` / zod change leaked into `search-notes.ts`.
- [ ] 5.5 Confirm no `__scratch__` path appears in any commit on the branch.
- [ ] 5.6 Push and open the PR against `main` with `gh pr create`. Never push directly to `main`.

## Parallelism

Groups 1 → 2 → 3 → 4 → 5 are **strictly sequential**. Every group after the first
consumes the previous group's committed state, and groups 2 and 3 are a
guard-then-change pair whose order is the whole point.

An earlier draft split the fold across four groups (widen type / collapse policy /
collapse caller / delete legacy). Each left the tree uncompilable, so none could be
tested or reviewed on its own. They are merged into group 3.
