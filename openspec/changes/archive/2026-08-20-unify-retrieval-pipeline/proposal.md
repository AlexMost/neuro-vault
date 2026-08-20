## Why

`retrieval-policy.ts` exports two functions for one behaviour: `executeRetrieval` (single query) and `executeMultiRetrieval` (query array) duplicate six pipeline steps line-for-line. Every recent policy change (4fa22d2, d540c4b) paid the tax in both bodies plus twice in a 1,305-line test file, and the two output shapes are then re-unified in the caller by four `let`s and an `isMultiNode` type guard.

An architecture review of `main @ 69adcb5` ranked this its top deepening candidate: the duplication sits in the hottest module in the repo (11 commits since May), the fix is pure deletion rather than new abstraction, and it unblocks the leg-report refactor — which would otherwise have to unify two shapes that should not exist in the first place.

## What Changes

**`retrieval-policy.ts` entry point**

- From: two exported functions — `executeRetrieval({ query: string, … })` and `executeMultiRetrieval({ queries: string[], … })` — with six duplicated pipeline steps (mode defaults, 0.3 fallback threshold, seed-scoped block search, per-seed block backfill, per-seed expansion, tree assembly).
- To: one exported `executeRetrieval({ queries: string[], … })`. The single query is the degenerate case, not a separate path.
- Reason: the duplicated bodies drift under change and the second output shape forces the caller to re-unify what the module split.
- Impact: non-breaking. Internal module boundary — one caller, no MCP contract change.

**Retrieval output shape**

- From: `RetrievalOutput { results: NoteResultNode[], truncated, fallback }` and `MultiRetrievalOutput { results: MultiNoteResultNode[], truncated, per_query_hits, per_query_fallback }`.
- To: one `RetrievalOutput { results: NoteResultNode[], truncated, per_query_hits, per_query_fallback }`.
- Reason: the scalar `fallback` is never read by any caller — `per_query_fallback[q]` carries the same bit for the single query.
- Impact: non-breaking. Both shapes are module-internal.

**Result node type**

- From: `MultiNoteResultNode extends NoteResultNode` with `matched_queries`; the caller recovers it via an `isMultiNode` type guard.
- To: one `NoteResultNode` that always carries `matched_queries` (`[q]` for a single query). `MultiNoteResultNode` and the type guard are deleted.
- Reason: an optional field distinguished by a runtime type test is the caller-side residue of the split.
- Impact: non-breaking. `matched_queries` still surfaces in MCP output only for array queries — that gate lives in `assembleUnified` and is keyed on `isMulti`, not on the node type.

**Test organization**

- From: invariants asserted once per pipeline across two `describe` blocks.
- To: each invariant asserted once, parameterized over arity (one query / many queries).
- Reason: asserting an invariant twice is the same tax the source change removes.
- Impact: non-breaking; coverage of every currently-asserted invariant is preserved.

## Capabilities

### New Capabilities

None. This change introduces no new capability.

### Modified Capabilities

- `hybrid-search`: adds a requirement that semantic-leg retrieval is arity-invariant — a single-query call and a one-element array call SHALL produce identical results, and every semantic-leg guarantee in this spec SHALL hold at both arities. This locks in the collapse so the two pipelines cannot regrow. No existing requirement changes; observable behaviour is unchanged.

## Impact

**Code**

- `src/modules/semantic/retrieval-policy.ts` — the fold; ~150–180 lines deleted.
- `src/modules/semantic/types.ts` — `MultiNoteResultNode` removed; `matched_queries` becomes required on `NoteResultNode`.
- `src/modules/semantic/tools/search-notes.ts` — the `isMulti` branch at the call site collapses to one call; four `let`s and the `isMultiNode` guard deleted. `isMulti` itself survives — it still gates `query_stats` and the `matched_queries` output field.
- `test/semantic/retrieval-policy.test.ts` — reorganized; invariants parameterized over arity.

**APIs**

- MCP contract unchanged. `search_notes` input schema, output shape, error codes, and the parameter dictionary are all untouched. No version bump beyond a patch/minor for the refactor itself.

**Dependencies**

- None added or removed.

**Docs**

- `docs/architecture/retrieval-policy.md` describes the two pipelines and must be rewritten to describe one.
- `docs/guide/finding-notes.md` and `docs/architecture/rank-fusion.md` reference the retrieval policy; both need a sweep for stale two-pipeline framing.

**Adjacent, explicitly out of scope**

- The review's candidate 4 (three copies of the stale-path existence filter) is suggested as a rider on this PR. It stays a separate change so the behaviour-preserving claim here remains cheap to verify.
