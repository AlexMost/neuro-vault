# Brainstorm — expansion-off-by-default

Tracked by #270. Decided on the evidence of the semantic-search research session of 2026-11-01
(internal report, not in the repository) and approved by the owner as the one semantic-side change
worth shipping from it. This file records the decision chain as it stood when the change was
opened; the brainstorm itself happened in the research session and in the hand-over brief, not in
a fresh dialogue.

## Background

`search_notes` fuses three rank sources: the semantic leg, the lexical leg and the expansion leg.
The expansion leg runs at `effort: "deep"` only: for each semantic seed it reads up to
`EFFORT_PROFILES.deep.expansionLimit` (3) embedding neighbours above the profile's
`expansionFloor`, flattens them into a third list and fuses that list at `EXPANSION_WEIGHT`
(0.5). It was added as a "fill the tail" source (#223, #232).

The research session ran the production pipeline (`runRetrievalPipeline`, effort `deep`,
production floors) against two private golden sets: the owner's vault (63 answerable and 17
control entries) and a corporate vault pair (30 entries). Grouped by `found_in`:

| group | personal: notes (relevant, precision) | corporate: notes (relevant, precision) |
|---|---|---|
| semantic only | 229 (35, 0.15) | 192 (35, 0.18) |
| two or more legs | 122 (85, 0.70) | 108 (49, 0.45) |
| lexical only | 226 (53, 0.23) | 146 (9, 0.06) |
| expansion only | 78 (3, 0.04) | 128 (1, 0.01) |

Switching the leg off, same pipeline (deltas against the production hybrid):

| | personal | corporate |
|---|---|---|
| list precision | 0.269 → 0.298 | 0.164 → 0.209 |
| notes per answer | 10.4 → 9.2 | 19.1 → 14.9 |
| notes on control entries | 1.5 → 1.1 | 4.0 → 2.0 |
| ΔMRR [95 % CI] | +0.017 [−0.01; 0.05] | +0.007 [0.00; 0.02] |
| Δrecall [95 % CI] | −0.016 [−0.04; 0.00] | −0.005 [−0.01; 0.00] |

Expansion by wikilink-graph neighbours, and graph ∪ embedding, measured the same as embedding
expansion: not worse than keeping it, not better than switching it off. Demoting semantic-only
hits, `min_legs`, and a z-score floor all hurt. The semantic leg itself is worth keeping (hybrid
against lexical-only: MRR +0.16 personal, +0.33 corporate).

## Decision log

**Q1: what is the change?** Stop running the expansion leg. The source of the neighbours is not
the problem (graph neighbours measured the same); the leg is. `EFFORT_PROFILES.deep` becomes
`expansion: false, expansionLimit: 0`, as `quick` already is.

**Q2: removed from the contract, or an opt-in parameter?** Removed. The research report offered
both; the hand-over brief asked for the simpler one unless the specs or ADRs argue otherwise.
- An opt-in `expansion?: boolean` would add a parameter to the MCP dictionary whose measured
  effect is more noise on both vaults, and would need its own description budget, tests and spec
  qualifiers ("when `expansion` is true …") on every expansion requirement.
- Removal makes the contract one sentence: no effort runs the leg, `found_in` never contains
  `"expansion"`, `expansion_similarity` never appears. Every spec requirement about the leg is
  modified or removed instead of qualified.
- Rejected: full deletion of the mechanism (`computeRelatedPerSeed`, `flattenExpansion`,
  `EXPANSION_WEIGHT`, `related[]`, the eval's `expansion` leg). It is a wider refactor (the
  parity oracle, the fusion tests, the eval's calibration statistics) for no behaviour change on
  top of the profile flip. It is the follow-up for the next major, together with Q3.

**Q3: what happens to `expansion_floor`?** It stays on the input schema, accepted and inert at
every effort and in every mode, and its schema description says so. Dropping a parameter is a
breaking change under the parameter dictionary (ADR-0005), and the parameter was already inert
in `quick` and `lexical`, so "inert everywhere" is a contract the schema already knew how to
express. It states no default any more (there is nothing it would default into) and names its
removal at the next major.

**Q4: what does the tool layer do with the retired source?** It stops emitting it: the
`found_in` union loses `"expansion"` and the entry type loses `expansion_similarity`, so the
contract is structural, not a matter of an empty list. `runRetrievalPipeline` and `fuseRanks`
keep the third source as data (it is always empty: `related[]` is empty when the policy does not
expand), and `executeRetrieval` keeps the expansion step behind `RetrievalInput.expansion`,
which no profile and no caller sets. The policy tests and the parity oracle still exercise that
step with an explicit input.

**Q5: the eval harness.** `evalConfig` reads the profile, so a report records
`expansion: false, expansion_limit: 0` with no edit. The `diagnostics.*.expansion` counter stays
(it is how a before/after report shows the leg is gone, and older reports stay comparable). The
`--stats` population `expansion_neighbours` ("the seed↔neighbour similarities the expansion leg
sees") is dropped: it mirrored the production leg at the effort's per-seed cap, and at a cap of
0 it would be an always-empty field. `seed_all` stays, because `expansionFloor` is still a
profile default and its pass rate is still measured there.

**Q6: docs.** Everything that says deep runs expansion follows the code: the `search_notes`
description, `docs/guide/finding-notes.md` and the other guide pages, the architecture pages
(`retrieval-policy.md`, `rank-fusion.md`, the dictionary, the README map), `GLOSSARY.md`,
`README.md`, `eval/README.md`. The architecture pages describe the mechanism as retired and
reachable only through the policy's input, so a reader of the code finds the same story.

**Q7: an ADR?** No. This is a measured retune of one fusion source, with the evidence on #270
and in the research report; it changes no architectural invariant. The decisions that added the
leg are in archived changes (`search-notes-unified-rank`, `weighted-rrf-expansion`) and stay
there.

## Acceptance

- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`, `npm run build` pass.
- Production fused deep eval on the owner's vault, before (main) and after (branch):
  `diagnostics.*.expansion` 0 after; hit@3 and MRR within ±0.02; R@10 down by at most about
  0.02; fewer notes on control entries. Aggregates only in the PR.
- Follow-up outside this change, owner's approval needed (about $25 per cell): one agent-level
  re-run of the personal vault × Opus A/B cell.
