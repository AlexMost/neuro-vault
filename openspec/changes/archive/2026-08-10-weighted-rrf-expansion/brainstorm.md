<!--
Raw capture of superpowers:brainstorming output.
Source material: a private vault task note on weighting the expansion leg in the fused rank
(2026-08-10, project [[neuro-vault]]), which arrived as a near-complete brainstorm:
scope locked, mechanics confirmed against code, out-of-scope stated. The in-chat
session verified the note's claims against the live source and resolved the two
open design forks with the user.
-->

# Brainstorm — Weighted RRF: down-weight the expansion leg in the fused rank

## Background

Report 2026-08-10 against live 14.0.0 `search_notes` (deep effort):

- `["ретеншн алертів", "retention alerts"]` → #1 `Archive/Оплатити соц страх і здравотку`,
  `found_in: ["expansion"]`, `matched_queries: []` — above all six semantic hits. The list
  then zips expansion/semantic with expansion winning every tie.
- «трейдинг» → `Archive/Доки через нову пошту` (expansion 0.9457) at #5; the same note
  surfaced as noise in the retention query — an expansion hub, adjacent to everything.
- Moby case (origin of the task) → `Tasks/Дата-гігієна фіду` (expansion-only) above
  `Projects/Moby dick bot` — 72 backlinks, direct semantic hit, literal name in query.

## Problem statement

The expansion leg competes with primary sources at equal weight, and at equal rank it wins
the tie-break — a note nobody searched for becomes #1 with `matched_queries: []`. Semantic
and lexical answer the query; expansion answers someone else's hit — a second-order signal,
and the flat fused list erased that distinction. Before unification, expansion's
subordination was structural (nested `related[]`); `found_in` carries it formally, but
order — the thing the first three positions are read by — no longer does.

## Mechanics (verified against source in this session)

- `fuseRanks` gives equal weights (`src/modules/semantic/rank-fusion.ts:47-54`); tie-break
  is `score → sourceCount → backlink_count → path` (`:55-61`).
- In the retention case the lexical leg is empty → at every rank semantic[i] and
  expansion[i] have identical scores, and the backlink step decides — and expansion
  candidates are hubs by nature (`flattenExpansion` takes max over all seeds; a hub
  surfaces many times). The AGENTS.md anti-pattern ("raw backlinks lift generic atoms")
  is reproduced inside the engine.
- `k` is adaptive (`√N`, clamp 5..60; ≈45 for this vault) → within-leg scores are nearly
  flat (1/46…1/55), so a weight is a topological switch, not a fine dial: w=0.9 puts
  expansion#1 ≈ primary#5; w≤0.75 puts it below all primary.
- RRF itself is healthy: «Прочитати Rethinking the Evaluation of Harness Evolution» hit #1
  at similarity 0.602, beating 0.642 and 0.626, because it was in two sources. The weight
  topology above it is what's broken, not the fusion.

## Decision chain

**Q1 — starting default for `w_expansion`?**
Options: 0.85 (middle of the note's 0.85–0.9 band; expansion can climb into mid-list when
primary evidence is thin, preserving the Moby-case value, but cannot take #1 over direct
hits), 0.75 (strictly below all primary — conservative but makes expansion a dead
appendix), 0.9 (lightest touch, still aggressive for hubs).
→ **Decided: 0.85.** Re-tune later via [[Retrieval eval harness]] data; the start is a
hand pick by design.

**Q2 — tie-break chain rework?**
Options: (a) drop `backlink_count` entirely → `score → sourceCount → path`; (b) demote it
behind an explicit primary-vs-expansion source-priority step.
→ **Decided: drop it.** With w<1 the cross-leg ties that made backlinks decisive vanish
structurally — the backlink step stops being an arena. Keeping it demoted is machinery for
a now-near-impossible case, and the backlink signal is exactly the documented anti-pattern.
Consequence: `fuseRanks` no longer needs its `getBacklinkCount` parameter at all
(`backlink_count` in the response payload is attached in `assembleUnified`, independently
of the comparator).

**Q3 — separate fusion-level weight for lexical:title vs lexical:body?**
→ **Deferred (out of scope).** The lexical leg's internal six-tier ordering already
encodes title > heading > body; no evidence yet that fusion-level splitting is needed.
Revisit with harness data.

## Design decisions

- `w_expansion` becomes a parameter of `fuseRanks` (`score += w / (k + rank)` for the
  expansion source; semantic and lexical stay at 1), with module-level default `0.85`.
  Not exposed as an MCP tool parameter — internal tuning knob, parameterized for the
  future eval harness.
- `sourceCount` semantics unchanged — expansion still counts as a source (it still
  carries provenance and multi-source reinforcement; only its rank contribution shrinks).
- Spec impact: MODIFIED requirement "Rank fusion is reciprocal-rank with adaptive k" in
  `openspec/specs/hybrid-search/spec.md` — it currently mandates equal weights and the
  backlink tie-break verbatim.
- Existing test `test/semantic/rank-fusion.test.ts` "breaks score ties by source count,
  then backlinks, then path" asserts the removed behavior → rewritten. The exact-tie
  sourceCount test keeps its intent (sourceCount step still exists) with backlink
  irrelevance asserted instead.
- The three report cases (retention, trading, Moby) become structural fixture tests as
  acceptance criteria: equal-rank expansion candidate must not beat the primary candidate
  even when the expansion path has (formerly decisive) more backlinks.

## Out of scope

- Removing expansion entirely — it is real: in the Moby case it was one of two sources
  that pulled in the key note. The question is "don't let it overtake", not "turn it off".
- Score normalization — RRF is rank-based; the differing scales (expansion 0.89–0.985
  note↔note vs semantic 0.60–0.85 query↔block) are irrelevant.
- ML re-ranker — [[Research reranker stage for search_notes]].
- Golden-set registration of the three cases — belongs to [[Retrieval eval harness]]
  (separate change); here they land as vitest fixtures.

## Acceptance criteria

- `npm test && npm run lint && npm run typecheck` pass.
- New fixture tests encoding the three report cases pass: expansion-only candidates rank
  below equal-rank primary candidates; a multi-source note still outranks a single-source
  higher-similarity note (RRF health preserved).
- Delta spec for `hybrid-search` validates (`openspec validate --all`).
