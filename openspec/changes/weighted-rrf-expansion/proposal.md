## Why

The expansion leg of `search_notes` competes with the primary legs (semantic, lexical) at equal RRF weight, and at equal rank it wins the tie-break via `backlink_count` — a note nobody searched for takes #1 with `matched_queries: []`. A 2026-08-10 report against live 14.0.0 shows three cases: a retention query topped by an unrelated Archive note found only via expansion; a hub note (`Доки через нову пошту`) surfacing as noise across unrelated queries; and the Moby case where an expansion-only note outranked a direct semantic hit with the literal name in the query. Expansion is a second-order signal (it answers someone else's hit, not the query) and the flat fused list erased that distinction.

## What Changes

**Expansion weight in RRF fusion**
- From: all three sources contribute `1 / (k + rank)` at equal weight.
- To: expansion contributes `w_expansion / (k + rank)` with `w_expansion` a `fuseRanks` parameter, module default `0.85`; semantic and lexical stay at weight 1.
- Reason: with adaptive k (≈45 here) within-leg scores are nearly flat, so the weight acts as a topological switch — 0.85 lets expansion climb into mid-list when primary evidence is thin but never take #1 over direct hits.
- Impact: non-breaking for the tool contract (input/output schemas unchanged); ranking order changes for deep-effort hybrid searches.

**Tie-break chain**
- From: `score → sourceCount → backlink_count → path`.
- To: `score → sourceCount → path`; `fuseRanks` drops its `getBacklinkCount` parameter.
- Reason: with w<1 the cross-leg exact ties that made backlinks decisive vanish structurally; the backlink step reproduced the documented anti-pattern (raw backlinks lift generic hub notes) inside the ranking engine.
- Impact: non-breaking; `backlink_count` remains in the response payload (attached in `assembleUnified`, independent of the comparator).

**Acceptance fixtures**
- The three report cases (retention, trading, Moby) become structural vitest fixtures in `test/semantic/rank-fusion.test.ts`, plus a guard that a multi-source note still outranks a single-source higher-similarity note (RRF health preserved).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `hybrid-search`: the "Rank fusion is reciprocal-rank with adaptive k" requirement changes — equal source weights become weighted (expansion at 0.85 by default), and the tie-break chain drops `backlink_count`.

## Impact

- `src/modules/semantic/rank-fusion.ts` — `fuseRanks` signature (add `weights`/`w_expansion`, remove `getBacklinkCount`), comparator, new default constant.
- `src/modules/semantic/tools/search-notes.ts` — `assembleUnified` call site no longer passes `getBacklinkCount`.
- `test/semantic/rank-fusion.test.ts` — two existing tie-break tests rewritten; three report-case fixtures and an RRF-health guard added.
- `openspec/specs/hybrid-search/spec.md` — delta for the fusion requirement.
- No MCP schema, parameter-dictionary, or error-code changes; no new dependencies. Golden-set registration of the report cases is deferred to the separate Retrieval-eval-harness change.
