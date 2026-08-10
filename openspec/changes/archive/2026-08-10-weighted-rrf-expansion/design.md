## Context

`search_notes` fuses three rank sources — semantic (query↔block embedding similarity), lexical (exact text tiers), and expansion (neighbours of semantic seeds, deep effort only) — via RRF in `fuseRanks` (`src/modules/semantic/rank-fusion.ts`). All sources contribute `1 / (k + rank)` at equal weight; ties break by `sourceCount`, then `backlink_count`, then `path`.

Two structural facts interact badly:

1. `k` is adaptive (`clamp(round(√N), 5, 60)`, ≈45 for the reporting vault), so within-leg reciprocal ranks are nearly flat (1/46…1/55). When the lexical leg is empty, semantic[i] and expansion[i] tie *exactly* at every rank i, and the backlink step decides every position.
2. Expansion candidates are hubs by construction — `flattenExpansion` keeps the max similarity across all seeds, so a note adjacent to everything surfaces repeatedly and carries many backlinks. The tie-break therefore systematically awards expansion the win: the AGENTS.md anti-pattern ("raw backlinks lift generic atoms") reproduced inside the engine.

Live report (2026-08-10, v14.0.0): an expansion-only Archive note at #1 above six semantic hits with `matched_queries: []`; a hub note recurring as noise across unrelated queries; an expansion-only note above a direct semantic hit whose literal name was in the query. RRF itself is healthy — a two-source note correctly beat higher-similarity single-source notes; the weight topology above it is what is broken.

Constraint: expansion must stay a real source — in the Moby case it was one of two sources that pulled in the key note. The goal is "cannot overtake primary", not "off".

## Goals / Non-Goals

**Goals:**

- Expansion contributions weighted below primary sources in the fused score, parameterized for future re-tuning by the eval harness.
- Tie-break chain free of `backlink_count`.
- The three report cases encoded as regression fixtures; RRF multi-source reinforcement provably intact.

**Non-Goals:**

- Removing or gating the expansion leg.
- Score normalization across legs (RRF is rank-based; scale differences are irrelevant by design).
- ML re-ranking (separate research task).
- Fusion-level weight split between lexical:title and lexical:body (the lexical leg's internal six-tier order already encodes it; revisit with harness data).
- Exposing the weight as an MCP tool parameter.
- Golden-set registration in the eval harness (separate change; fixtures here are vitest-local).

## Decisions

### D1: `w_expansion` as a `fuseRanks` parameter, module default 0.85

- **Choice**: `fuseRanks` accepts an optional expansion weight (default `EXPANSION_WEIGHT = 0.85` in `rank-fusion.ts`); the expansion source's contribution becomes `w / (k + i + 1)`, semantic and lexical stay at 1.
- **Rationale**: with near-flat within-leg scores, the weight is a topological switch, not a fine dial — w=0.9 puts expansion#1 ≈ primary#5, w≤0.75 puts expansion below all primary. 0.85 (user-confirmed) keeps expansion able to enter mid-list when primary evidence is thin, preserving its demonstrated recall value, while making expansion-over-direct-hit at #1 impossible. Parameterization (not a hard-coded constant inside the loop) is what the eval harness will need for sweeps.
- **Alternatives considered**: 0.75 default — rejected: makes expansion a dead appendix that can never outrank even weak primary tail. 0.9 — rejected: still fairly aggressive for hubs. Per-source weight map for all three legs — rejected (YAGNI): only expansion has evidence of miscalibration; a single scalar keeps the contract minimal and is trivially generalizable later.

### D2: Tie-break drops `backlink_count`; `fuseRanks` drops `getBacklinkCount`

- **Choice**: comparator becomes `score desc → sourceCount desc → path asc`. The `getBacklinkCount` parameter is removed from `fuseRanks` entirely; `assembleUnified` keeps attaching `backlink_count` to response entries independently.
- **Rationale**: the exact cross-leg ties that made backlinks decisive only exist because equal weights make `1/(k+i)` collide across legs; with w<1 on expansion they vanish structurally. What remains of the backlink step is pure hub bias — the documented anti-pattern. Removing the parameter (rather than ignoring it) keeps the signature honest.
- **Alternatives considered**: demote backlinks behind an explicit primary-vs-expansion priority step — rejected: machinery for a now-near-impossible case, and it preserves a signal we have direct evidence against. Keep parameter but unused — rejected: dead contract surface.

### D3: `sourceCount` semantics unchanged

- **Choice**: expansion still increments `sourceCount` and still emits `found_in: ["expansion"]` provenance.
- **Rationale**: multi-source reinforcement is the healthy part of RRF (verified by the report's positive case); the weight already handles subordination. Excluding expansion from `sourceCount` would double-penalize it.

### D4: Report cases as structural fixtures, not vault snapshots

- **Choice**: encode the three cases in `test/semantic/rank-fusion.test.ts` as synthetic rank lists reproducing the failure geometry (empty lexical leg + parallel semantic/expansion lists; expansion hub with high backlinks at equal rank; expansion-only vs multi-source direct hit), asserting the corrected order. Add a guard test that a two-source mid-rank note still beats a single-source top hit.
- **Rationale**: the failure is a property of the fusion math, not of vault content; structural fixtures survive vault drift and run without a corpus. The existing test "breaks score ties by source count, then backlinks, then path" asserts the removed behavior and is rewritten; the exact-tie sourceCount test keeps its intent with backlink irrelevance asserted instead.

## Risks / Trade-offs

- [Risk] 0.85 is a hand-picked start, not a tuned value → Mitigation: it is a single module constant, parameterized through `fuseRanks`; the Retrieval eval harness change re-tunes it against a golden set that will include these three cases.
- [Risk] Ranking order changes for existing users' deep searches → Accepted: that order is the reported defect; input/output schemas and evidence fields are untouched, so the change is behavioral only. Semver: minor/patch-level behavior fix, no contract break.
- [Trade-off] Dropping `backlink_count` from the comparator removes a determinism helper for residual exact ties → `path asc` remains as the final total-order step, so determinism is preserved; we only lose a biased middle step.
- [Trade-off] Expansion can still appear mid-list among weak primary tails at w=0.85 → intended: that is exactly the recall value the Moby case demonstrated.

## Migration Plan

N/A — no deployment, schema, or data migration. Single PR: code + tests + delta spec; normal release via `npm run release` on `main` after merge. Rollback = revert the PR (the previous ordering returns).

## Open Questions

_None blocking._ Deferred to the Retrieval eval harness change: empirical re-tune of the 0.85 default; whether fusion-level lexical sub-weights are ever warranted.
