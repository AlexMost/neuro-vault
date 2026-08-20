## Context

`src/modules/semantic/retrieval-policy.ts` (420 lines) is the semantic leg's
policy layer: it turns a query plus mode defaults into a tree of seed notes,
each with block evidence and per-seed expansion. It sits between the deep
`search-engine` primitives (`findNeighbors`, `findBlockNeighbors`) and the
`search_notes` tool layer, which fuses it with the lexical leg.

The module currently exports **two** entry points for that one behaviour:

| | `executeRetrieval` | `executeMultiRetrieval` |
| --- | --- | --- |
| input | `query: string` | `queries: string[]` |
| output | `{ results: NoteResultNode[], truncated, fallback }` | `{ results: MultiNoteResultNode[], truncated, per_query_hits, per_query_fallback }` |
| lines | ~115 | ~160 |

Six pipeline steps are duplicated between them line-for-line: mode defaults,
the 0.3 fallback threshold, seed-scoped block search, per-seed block backfill,
per-seed expansion (already shared via `computeRelatedPerSeed`), and tree
assembly. `test/semantic/retrieval-policy.test.ts` is 1,305 lines because the
same invariants are asserted once per pipeline.

The split does not stop at the module boundary. `runSearchForEntry` in
`search-notes.ts` declares four `let`s and branches on `isMulti` to call one or
the other (`search-notes.ts:407-437`), and `assembleUnified` carries an
`isMultiNode` type guard (`search-notes.ts:154`) to recover `matched_queries`
from a union type. The caller spends code re-unifying what the module split.

**Constraints.**

- The MCP contract is fixed. `search_notes` output must be byte-identical.
  `matched_queries` surfaces only for array queries; `query_stats` is
  array-query-only. Both gates live in the tool layer and stay there.
- ADR-0005: one concept = one parameter name. No tool parameter changes here,
  so the dictionary is untouched.
- `npx tsc --noEmit` is the authority on type-correctness (ADR-0002); a `tsup`
  build alone is not, because of `isolatedModules`.
- The repo's testing rule: assert through the SDK gate
  (`reg.spec.inputSchema`), not handler-direct, when checking tool surface.

**Verification done before designing.** The claim "the multi path degenerates
cleanly to the single case" was checked against source rather than taken from
the review. Seed ordering is preserved because `mergeNoteResults`' comparator
(`similarity desc, path asc`) is character-identical to `compareSearchResults`
in `search-engine.ts:26`, which already orders `findNeighbors` output. At n=1
the merge is therefore a no-op. `truncated`, block dedup, and backfill reduce
to the single-query values at n=1 — the full table is in
[`brainstorm.md`](brainstorm.md).

**The load-bearing invariant.** That equivalence is not self-contained: it
rests on `findNeighbors` returning results already sorted by the comparator
`mergeNoteResults` re-applies. Spelled out:

- `toSearchResults` ends with `results.sort(compareSearchResults)`
  (`search-engine.ts:89`), and `findNeighbors` only slices to `limit` after
  that (`search-engine.ts:108-110`).
- `compareSearchResults` is `right.similarity - left.similarity ||
  compareStrings(left.path, right.path)` (`:26-28`), and `compareStrings` is
  `left.localeCompare(right)` (`:22-24`).
- `mergeNoteResults` sorts by `b.similarity - a.similarity ||
  a.path.localeCompare(b.path)` — the same total order.
- Paths are unique (they are `Map` keys over vault sources), so the
  comparator never returns 0 for two distinct entries. It is therefore a
  *strict* total order: the sorted arrangement is unique, and re-sorting an
  already-sorted array is idempotent regardless of sort stability.

The invariant is already pinned by a committed test —
`test/semantic/search-engine.test.ts:61` ("breaks ties deterministically")
feeds sources in the order `zeta, beta, alpha` and asserts `findNeighbors`
returns `['alpha.md', 'zeta.md']`. If a future change makes `findNeighbors`
order-preserving instead of sorting, that test fails first, and this
refactor's premise fails with it. The dependency is recorded here so the
connection is visible from both ends.

This was not theoretical: the differential harness (D6) initially fed its
tie-break case a mock `findNeighbors` returning `[note-c, note-a, note-b]`
all at similarity 0.7, and the two implementations disagreed — legacy
preserved the mock's order, unified normalized it. The mock, not the code,
was wrong: the real engine cannot return that order. The case now feeds
engine-ordered input, and this section documents why that is the correct
fixture rather than a weakened assertion.

## Goals / Non-Goals

**Goals:**

- One exported retrieval entry point taking `queries: string[]`, with the
  single query as the degenerate case.
- One result node type that always carries `matched_queries`; delete
  `MultiNoteResultNode` and the caller's `isMultiNode` type guard.
- Each retrieval invariant asserted once in tests, parameterized over arity.
- Observable behaviour unchanged — same results, same order, same `truncated`,
  same MCP output for every input.
- A spec requirement that pins arity-invariance, so the two pipelines cannot
  regrow under a later change.

**Non-Goals:**

- Any MCP contract change — no new/renamed parameters, no output field
  changes, no error-code changes.
- Candidate 4 from the review (unifying the three copies of the stale-path
  existence filter). Valuable, independently verifiable, separate change.
- Candidate 5 (leg reports / `assembleUnified` source interface). This change
  is its precondition, not its start.
- Any retrieval-quality change. Thresholds, fallbacks, expansion floors, and
  block-selection policy keep their current values and semantics.
- Performance work. The fold adds a `Map` and a sort to the single-query path;
  both are O(k) over ≤ 9 seeds and irrelevant next to the embedding call.

## Decisions

### D1: Fold toward the multi-query pipeline, deleting the single-query one

- **Choice:** one export, `executeRetrieval({ queries: string[], … })`.
  `executeMultiRetrieval` is deleted; its body becomes the single
  implementation. The old name survives because it is the shorter, more
  natural one and every call site changes anyway.
- **Rationale:** the multi pipeline is a strict superset — every single-query
  step appears in it, plus a merge that is a no-op at n=1. Folding the other
  direction is not possible; folding toward a third shared implementation
  keeps both shapes alive, which is the actual tax.
- **Alternatives considered:**
  - *Keep both exports, make `executeRetrieval` a wrapper.* Rejected: the
    interface does not shrink, only the body does. A reader still has to ask
    which one to call, and the caller keeps its four `let`s because the output
    shapes still differ.
  - *Extract the six steps into private helpers, keep both entry points thin.*
    Rejected: needs six helpers threading `queryVector[]` through each, and
    `RetrievalOutput` vs `MultiRetrievalOutput` and `NoteResultNode` vs
    `MultiNoteResultNode` all survive untouched — so the caller-side branch and
    type guard survive too. The second *shape* is the cost, not the second
    body.

### D2: Drop the scalar `fallback`; `per_query_fallback` is the survivor

- **Choice:** the unified `RetrievalOutput` is
  `{ results, truncated, per_query_hits, per_query_fallback }`. The scalar
  `fallback: boolean` is deleted.
- **Rationale:** no caller reads it. The single-query call site
  (`search-notes.ts:426`) destructures only `results` and `truncated`; the
  field is asserted only in `retrieval-policy.test.ts`. `per_query_fallback[q]`
  carries exactly the same bit, so no information is lost and the fallback
  tests re-target rather than disappear. The MCP-visible
  `query_stats.<q>.semantic_fallback` already reads from `per_query_fallback`
  and is unchanged.
- **Alternatives considered:** *keep both, deriving the scalar as
  `Object.values(per_query_fallback).some(Boolean)`.* Rejected: it adds a
  field with no reader and an aggregation rule nobody has needed to define.

### D3: One node type that always carries `matched_queries`

- **Choice:** `NoteResultNode` gains a required `matched_queries: string[]`
  (`[q]` for a single query). `MultiNoteResultNode` is deleted from
  `types.ts`, along with the `isMultiNode` guard in `search-notes.ts`.
- **Rationale:** the union type exists only because one pipeline populated the
  field and the other did not. With one pipeline, `matched_queries` is always
  computable and always meaningful. `types.ts` confirms the type is internal —
  it appears only in `retrieval-policy.ts`, `search-notes.ts`, and `types.ts`.
- **Alternatives considered:** *make it optional (`matched_queries?`).*
  Rejected: an optional field the producer always sets is a lie about the type,
  and it invites `?? []` at every read site — the guard in a cheaper disguise.

### D4: The tool layer keeps deciding what surfaces; the policy layer stops deciding what to compute

- **Choice:** `isMulti` survives in `search-notes.ts` and keeps gating both
  `query_stats` (`buildQueryStats` early-returns `undefined` when false) and
  the `matched_queries` field in each match (`assembleUnified`, keyed on
  `isMulti`). What goes away is the *call-site* branch and the type guard.
- **Rationale:** this is the seam that makes the change contract-safe.
  Computing `matched_queries` for a single query costs one array allocation;
  *surfacing* it would be a breaking MCP change. Separating "always compute" in
  the policy layer from "conditionally surface" in the tool layer is what lets
  the pipeline collapse without the contract moving.
- **Alternatives considered:** *pass an `isMulti` flag into the policy layer to
  suppress the extra fields.* Rejected: it re-introduces a branch inside the
  module to eliminate a branch in the caller, and makes the policy layer
  depend on a presentation concern.

### D5: Pin arity-invariance as a spec requirement

- **Choice:** add one requirement to `openspec/specs/hybrid-search` stating
  that semantic-leg retrieval is arity-invariant — `query: "x"` and
  `query: ["x"]` produce identical `matches[]` ordering and evidence, and
  every semantic-leg guarantee in that spec holds at both arities. The known
  exceptions (`matched_queries` and `query_stats` surfacing only for arrays)
  are named explicitly as surfacing rules, not retrieval differences.
- **Rationale:** the refactor's value decays if a later change re-splits the
  path. A behaviour-level requirement is the durable form of "one pipeline" —
  it survives even if the internal function names change again.
- **Alternatives considered:** *no spec change, since behaviour is unchanged.*
  Rejected: true but weak. The requirement is not describing new behaviour, it
  is making an implicit guarantee explicit and testable, which is exactly what
  stops the duplication returning.

### D6: Prove equivalence with a throwaway differential test, ship the parameterized suite

- **Choice:** during the fold, run a scratch differential test that executes
  the pre-fold `executeRetrieval` and the unified one over the same fixtures
  and asserts deep-equality of results and ordering. It is **not committed**.
  What ships is the reorganized suite: each invariant asserted once, run at
  both arities via a table.
- **Rationale:** the real risk here is a silent ordering or truncation slip
  that the existing per-pipeline tests do not pin, because each pipeline's
  tests only ever saw its own arity. A differential harness catches that
  during the work; a parameterized suite is what keeps catching it afterwards.
  Committing the differential test would mean committing a copy of the deleted
  implementation — the very thing being removed.
- **Alternatives considered:** *trust the existing suite.* Rejected: it asserts
  each invariant against exactly one arity, so an arity-dependent regression is
  precisely what it cannot see.

## Risks / Trade-offs

- **[Risk] A silent ordering regression on the single-query path.** The merge
  step introduces a `Map` round-trip and a re-sort that the old path did not
  have. → *Mitigation:* the comparators are verified character-identical
  (`retrieval-policy.ts:256` vs `search-engine.ts:26`), and D6's differential
  test exercises the equivalence over real fixtures before the old body is
  deleted. Deletion happens last, not first.

- **[Risk] `truncated` semantics shift for a single query.** The unified path
  computes `mergeOverflow || anyQueryOverflow` where the old path computed a
  single pool-overflow check. → *Mitigation:* at n=1, `merged.length` cannot
  exceed `limit` (the per-query slice already bounded it), so `mergeOverflow`
  is always false and the expression reduces exactly. The parameterized
  truncation tests assert this at both arities rather than assuming it.

- **[Risk] The MCP contract moves by accident** — most plausibly
  `matched_queries` leaking into single-query matches once every node carries
  it. → *Mitigation:* D4 keeps the `isMulti` gate exactly where it is, and the
  acceptance check asserts through the SDK gate (`reg.spec.inputSchema`) that a
  single string query yields matches with no `matched_queries` key and no
  `query_stats`.

- **[Risk] Stale docs outlive the code.** `docs/architecture/retrieval-policy.md`
  describes two pipelines; `docs/guide/finding-notes.md` and
  `docs/architecture/rank-fusion.md` reference the policy layer. → *Mitigation:*
  the doc sweep covers all of `docs/`, not just `docs/architecture/` — an
  architecture-scoped grep misses the model-facing guide layer.

- **[Trade-off] The single-query path now allocates a `Map`, runs a sort, and
  awaits a one-element `Promise.all`.** Accepted: O(k) over at most `limit + 1`
  seeds (3 quick, 8 deep), dwarfed by the embedding call that precedes it.

- **[Trade-off] `per_query_hits` and `per_query_fallback` are computed for
  single-query calls and discarded by the caller.** Accepted: two `Record`
  entries. The alternative (a suppression flag) trades a branch for a branch
  and couples the policy layer to a presentation concern — see D4.

- **[Trade-off] The signature is wider for the one caller that only ever
  passes a single query — it must now write `queries: [q]`.** Accepted: one
  pipeline to learn beats picking between two, and there is exactly one call
  site.

## Migration Plan

No deployment change — this is an internal refactor with no MCP contract, DB,
or endpoint impact. The sequencing that matters is within the change itself:

1. Rename and widen: `executeMultiRetrieval` becomes `executeRetrieval`
   (`queries: string[]`), with the old single-query body still present under a
   temporary name so both can run side by side.
2. Point the caller at the unified entry point; collapse the four `let`s and
   delete the `isMultiNode` guard. Collapse the node types.
3. Run the scratch differential test (D6) over both implementations. It must
   be green before step 4.
4. Delete the old body and its temporary name.
5. Reorganize the test suite: each invariant once, parameterized over arity.
6. Sweep all of `docs/` for two-pipeline framing; rewrite
   `docs/architecture/retrieval-policy.md`.

**Acceptance:** `npm test`, `npm run lint`, and `npx tsc --noEmit` all pass;
`openspec validate --all` passes; the SDK-gate assertion in D4's mitigation
holds for both a string query and a one-element array query.

**Rollback:** revert the PR. No data, schema, or published-contract migration
is involved, so revert is complete and immediate.

## Open Questions

None blocking. Two deliberately deferred, both recorded in the proposal as
out of scope:

- Whether candidate 4 (`filterExisting` on the vault entry) rides along in
  this PR. Decided no — it would blur the behaviour-preserving claim that makes
  this change cheap to review.
- Whether candidate 5 (leg reports) follows immediately. It is unblocked by
  this change but scoped separately.
