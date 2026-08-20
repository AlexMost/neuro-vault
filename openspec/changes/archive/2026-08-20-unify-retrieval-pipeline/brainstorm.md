# Brainstorm — unify-retrieval-pipeline

Raw capture. Format: background → decision chain → trade-offs.

## Background

An architecture review of `main @ 69adcb5` (deepening-candidate sweep, each
candidate adversarially verified by an independent agent) ranked six
candidates. Candidate 1 was the top recommendation and is the scope of this
change; the user asked for that one item only.

The review's finding, restated:

> `src/modules/semantic/retrieval-policy.ts` (420 lines) exports **two
> interfaces for one behaviour**. `executeRetrieval` (single query) and
> `executeMultiRetrieval` (query array) duplicate six pipeline steps
> line-for-line — mode defaults, the 0.3 fallback threshold, seed-scoped block
> search, per-seed block backfill, per-seed expansion, tree assembly. Every
> recent policy change (4fa22d2, d540c4b) paid the tax in both bodies plus
> twice in `test/semantic/retrieval-policy.test.ts` (1,305 lines, invariants
> asserted once per pipeline).
>
> The two output shapes then have to be **re-unified in the caller**:
> `runSearchForEntry` in `search-notes.ts` declares four `let`s and branches on
> `isMulti`, and `assembleUnified` carries an `isMultiNode` type guard to
> recover `matched_queries`.
>
> Deletion test: removing `executeRetrieval` reappears nowhere — a one-line
> `queries: [q]` wrapper suffices. It fails the deletion test.

## Pre-brainstorm verification (read the code, don't trust the report)

Before treating "the multi path degenerates cleanly to the single case" as a
premise, each step where the two bodies differ was checked against source:

| Step | Single path | Multi path at n=1 | Equivalent? |
| --- | --- | --- | --- |
| Seed ordering | `findNeighbors` order, i.e. `compareSearchResults` = `similarity desc, path asc` (`search-engine.ts:26`) | `mergeNoteResults` sorts `b.similarity - a.similarity \|\| a.path.localeCompare(b.path)` (`retrieval-policy.ts:256`) | **Yes** — identical comparator, so the merge is order-preserving at n=1 |
| `truncated` | `vectorResults.length > limit` | `mergeOverflow \|\| anyQueryOverflow`; at n=1 `merged.length ≤ limit` so `mergeOverflow` is false and the value reduces to the per-query pool overflow | **Yes** |
| Block search | one pass over one `queryVector`, bucket per path | same pass, then dedup by `path\0heading\0lines` keeping max similarity | **Yes** — one pass produces no duplicate keys, so the Map is a no-op; `Map` preserves insertion order, and the final `sort` comparator is identical in both |
| Block backfill | best block at threshold 0 for each starved seed | same, maximised over query vectors (one vector at n=1) | **Yes** |
| Expansion | `computeRelatedPerSeed` | the *same* helper, already shared | **Yes** — already deduplicated |
| `fallback` | scalar on the output | `per_query_fallback[q]` | **Yes**, modulo shape (see Q2) |

Conclusion: the equivalence claim holds. This is a behaviour-preserving
refactor, not a behaviour change — which is what makes it a candidate for
"delete, don't add".

## Decision chain

### Q1 — Which direction does the fold go?

**Options.**
(a) Keep both exports, implement `executeRetrieval` as a wrapper over
`executeMultiRetrieval`.
(b) One export `executeRetrieval({ queries: string[], … })`; delete
`executeMultiRetrieval`; the single query becomes the degenerate case.
(c) Extract the six shared steps into private helpers, keep both public
entry points thin.

**Decision: (b).**

(a) leaves two names in the module's interface, so a reader still asks "which
one do I call?" — the interface does not shrink, only the body does. (c) is
the classic "share the implementation, keep the API" move, but here it would
need a helper per step (six of them) threading `queryVector[]` through each,
and the *shapes* — `RetrievalOutput` vs `MultiRetrievalOutput`,
`NoteResultNode` vs `MultiNoteResultNode` — would survive untouched, so the
caller's four `let`s and `isMultiNode` guard stay. The review's point is that
the second shape is the tax, not the second body.

(b) is the only option where the caller simplifies too.

### Q2 — What happens to the scalar `fallback` field?

`RetrievalOutput.fallback` (boolean) has no analogue in
`MultiRetrievalOutput`, which carries `per_query_fallback: Record<string,
boolean>` instead.

Checked: **`search-notes.ts` never reads the scalar `fallback`.** The
single-query branch (`retrieval-policy.ts` call site at `search-notes.ts:426`)
destructures only `results` and `truncated`. The field is asserted only in
`retrieval-policy.test.ts`.

**Decision:** drop the scalar; `per_query_fallback` is the survivor.
`per_query_fallback[q]` for the single query carries exactly the same bit, so
no information is lost and the tests that assert fallback behaviour re-target
rather than disappear. The MCP-visible `query_stats.<q>.semantic_fallback`
already comes from `per_query_fallback` and is array-query-only — unchanged.

### Q3 — Do the two node types collapse?

`MultiNoteResultNode extends NoteResultNode` with `matched_queries: string[]`
(`types.ts:44`). The multi pipeline always populates it; the single one never
does, which is why `assembleUnified` needs `isMultiNode`.

**Decision:** one node type that always carries `matched_queries`. For a
single query it is `[q]`.

Scope note: `MultiNoteResultNode` is an **internal** type — grep confirms it
appears only in `retrieval-policy.ts`, `search-notes.ts`, and `types.ts`.
Collapsing it is invisible outside the semantic module.

### Q4 — Does the MCP contract change?

No, and this is a hard constraint on the change.

`matched_queries` surfaces in a `search_notes` match **only for array
queries** — `assembleUnified` gates it on `isMulti`, not on the node type.
That gate stays exactly where it is. The tool layer keeps deciding what
surfaces; the policy layer stops deciding what to compute.

So `isMulti` survives in `search-notes.ts` (it still drives `query_stats` and
the `matched_queries` gate), while the four `let`s and the `isMultiNode` type
guard go away. Verified against the SDK gate, not just the handler — per the
repo's testing rule, `search_notes` output shape is asserted through
`reg.spec.inputSchema` in the tool-surface tests.

### Q5 — Does candidate 4 (`filterExisting`) ride along?

The review suggests folding candidate 4 — the three copies of the stale-path
existence filter — into the same PR.

**Decision: no.** The user scoped this to "1 пункт" (item 1). Candidate 4 is
independently valuable and independently verifiable; bundling it would blur
the "behaviour-preserving refactor" claim that makes this change cheap to
review. It stays a separate change.

### Q6 — How is behaviour preservation demonstrated?

The risk of a fold like this is a silent ordering or truncation regression
that no test pins. Options considered: (a) trust the existing suite, (b) add a
temporary differential test that runs old and new implementations over the
same fixtures and asserts identical output, (c) reorganize the test file so
each invariant is asserted once and parameterized over `[1 query, n queries]`.

**Decision: (c), with (b) as a scaffold during the fold.**

The 1,305-line test file asserts the same invariants twice today — that
duplication is part of the tax being paid off. Reorganizing so each invariant
is stated once and exercised at both arities is the durable form. A throwaway
differential test against the pre-fold `executeRetrieval` (kept on a scratch
branch, not committed) is the cheap way to catch an ordering slip during the
work itself.

## Design trade-offs accepted

- **A single-query call now allocates a `Map` and a sort it did not before.**
  Both are O(k) over at most `limit + 1` seeds (3 quick / 8 deep). Irrelevant
  next to the embedding call that precedes them.
- **`Promise.all` over a one-element array** for the single-query case — one
  extra microtask. Same reasoning.
- **The unified signature is wider** than the old single-query one: callers
  who only ever pass one query must write `queries: [q]`. There is exactly one
  such caller. The review's framing — "one pipeline to learn" beats "the
  narrower of two pipelines to pick between" — holds at N=1 caller.
- **`per_query_hits` / `per_query_fallback` are now computed for single-query
  calls too** and thrown away by the caller. Two `Record` entries. Accepted
  over adding a mode flag to suppress them, which would re-introduce a branch
  to eliminate a branch.

## Expected outcome

- ~150–180 source lines deleted from `retrieval-policy.ts`
- four `let`s + one type guard deleted from `search-notes.ts`
- invariants asserted once, parameterized over arity
- MCP contract byte-identical
- unblocks candidate 5 (leg reports), which would otherwise have to unify the
  two shapes this change collapses
