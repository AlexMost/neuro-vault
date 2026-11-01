## Context

`search_notes` ranks one `matches[]` list by reciprocal-rank fusion over three sources
(`src/modules/semantic/rank-fusion.ts`): the semantic leg, the lexical leg and the flattened
expansion leg. The expansion leg is step 5 of `executeRetrieval`
(`src/modules/semantic/retrieval-policy.ts`): one `nearest` read anchored on every seed, floored
at `expansionFloor`, capped per seed at `EFFORT_PROFILES.<effort>.expansionLimit`. The
`quick` profile has it off; `deep` runs it with a cap of 3, and the fused list weights it at
`EXPANSION_WEIGHT = 0.5` (#223, change `weighted-rrf-expansion`).

The semantic-search research session of 2026-11-01 (internal report; two private golden sets)
grouped production deep results by `found_in`. Expansion-only notes were relevant 4 % and 1 % of
the time, against 15–18 % for semantic-only, 6–23 % for lexical-only and 45–70 % for notes two
legs agree on. Switching the leg off moved list precision +0.03 / +0.045, notes per answer
10.4 → 9.2 / 19.1 → 14.9, notes on control entries 1.5 → 1.1 / 4.0 → 2.0, MRR +0.017 / +0.007
and recall −0.016 / −0.005, the last two inside their confidence intervals. Wikilink-graph
neighbours in place of embedding neighbours measured the same. The owner approved switching the
leg off as the one semantic-side change to ship from that session (#270).

Baseline on `main` (1450c51) at the start of this change, production fused deep, `harrier-270m`,
the owner's 80-entry golden set (63 answerable, 17 controls):

| hit@3 | MRR | R@10 | controls returning anything | mean notes on controls | expansion-sourced notes (answerable / control) |
|---|---|---|---|---|---|
| 0.905 | 0.817 | 0.830 | 3 of 17 | 1.53 | 128 / 8 |

## Goals / Non-Goals

**Goals:**

- No `search_notes` call runs the expansion leg; a deep call returns a shorter, more precise
  list with hit@3 and MRR held.
- The contract says so structurally: `found_in` has no `"expansion"` value and entries have no
  `expansion_similarity` field.
- `expansion_floor` keeps being accepted, so no caller breaks, and its description tells the
  truth.
- Every document that describes the deep profile or the leg agrees with the code.

**Non-Goals:**

- An opt-in parameter, a graph-based or hybrid neighbour source, or a re-tune of
  `EXPANSION_WEIGHT`.
- Deleting the expansion mechanism from the policy, the pipeline, the fusion module or the
  eval's leg diagnostics (next major, together with the parameter).
- Any change to the semantic or lexical legs, the floors, the pools or the merged caps.
- A reindex: vectors are untouched and `embed_version` does not move.
- The agent-level A/B re-run (owner's approval, separate).

## Decisions

### D1: Switch the leg off in the effort profile, not behind a parameter

- **Choice:** `EFFORT_PROFILES.deep` becomes `expansion: false, expansionLimit: 0`, the values
  `quick` already has. `MODE_DEFAULTS` in the policy reads the profile, so no effort expands.
- **Why:** the measured effect is the same direction on both vaults, and the alternative neighbour
  source measured the same, so there is no configuration of the leg worth offering.
- **Alternatives considered:**
  - `expansion?: boolean` (default false) on `search_notes`, plumbed through
    `RetrievalPipelineInput`. A new dictionary entry, description budget and spec qualifiers for a
    knob whose measured effect is noise. Rejected.
  - Graph or hybrid neighbours. Measured as not better than switching the leg off. Rejected.

### D2: `expansion_floor` stays on the schema, accepted and inert

- **Choice:** the zod field stays (`z.number().min(0).max(1).optional()`, coerced by the gate).
  Its description says the leg no longer runs at any effort, that the value has no effect, and
  that the parameter goes at the next major. It states no default.
- **Why:** removing a parameter is a breaking change under the parameter dictionary (ADR-0005)
  and this change is a minor. The parameter was already inert at `quick` and in `lexical`, so the
  spec already has the words for it. The description must not claim a default the server does
  not apply (embedding-model-profiles: descriptions state what the server applies).
- **Alternatives considered:** dropping the field now and shipping a major. The change is too
  small to carry a major, and the next major can delete the mechanism with it.

### D3: The tool layer stops emitting the source; the layers below keep it as data

- **Choice:** `search-notes.ts` narrows `found_in` to the four live values and drops
  `expansion_similarity` from the entry type and the response mapping, and drops the
  `expansion_similarity` RESPONSE SHAPE line from the description. `runRetrievalPipeline` keeps
  flattening `related[]` (always empty) and `fuseRanks` keeps its third list and weight.
  `executeRetrieval` keeps step 5 behind `RetrievalInput.expansion`, which no profile and no
  caller sets; the comments say so.
- **Why:** the contract should be impossible to violate by construction, which the type gives.
  Below the tool, the mechanism is reached only by the policy tests and the parity oracle
  (`test/semantic/_legacy-retrieval.ts`), which pass `expansion: true, expansionLimit: 3`
  explicitly; deleting it is a wider refactor with no behaviour change and belongs with the
  parameter's removal.
- **Alternatives considered:** keeping the tool's union and field "in case". A field no code can
  produce is a lie in the type; rejected.

### D4: The eval follows the profile and drops the population that mirrored the leg

- **Choice:** `evalConfig` keeps reading the profile (`expansion: false, expansion_limit: 0`,
  `expansion_floor` and `expansion_weight` still recorded as knobs in effect). The
  `diagnostics.*.expansion` counter stays, so a before/after pair shows the leg at 0 and older
  reports stay comparable. `collectPopulations` loses `expansion_neighbours` and its
  `expansionLimit` argument; `seed_all` stays, since `expansionFloor` is still a profile default
  whose pass rate `--stats` measures.
- **Why:** `expansion_neighbours` was defined as "the seed↔neighbour similarities the expansion
  leg sees"; at a per-seed cap of 0 it is an always-empty field, and reporting it would describe
  a leg that does not run.
- **Alternatives considered:** keeping the population at a fixed cap of 3 as a diagnostic. It
  would no longer mirror production, which was its definition. Rejected.

### D5: Docs describe a retired mechanism, not an absent one

- `docs/architecture/retrieval-policy.md` and `rank-fusion.md` keep their step and flattening
  sections, headed as retired: off in every profile, reachable through the policy's input only,
  the third fusion list always empty. The guide, the dictionary, the architecture map,
  `GLOSSARY.md`, `README.md` and `eval/README.md` say deep runs no expansion and that
  `expansion_floor` is inert. ADR-0017 and the research reports are history and stay as written.

### D6: No ADR

- A measured retune of one fusion source, evidenced on #270 and in the research report. It
  changes no invariant a prior ADR records; the decisions that added the leg live in archived
  changes.

## Risks / Trade-offs

- [Risk] Deep recall drops on the owner's vault by more than the research measured (−0.016).
  → Mitigation: the after-eval in this change reads R@10 against the 0.830 baseline; a drop
  beyond about 0.02 goes to the owner before the PR merges.
- [Risk] A caller that keyed on `found_in: ["expansion"]` to find "related" notes loses that
  path. → Mitigation: `get_similar_notes` is the tool for neighbours of a known note and the
  routing guide already says so; the description's example for exploration is unchanged.
- [Risk] The parity oracle and the policy tests keep a mechanism alive that production never
  runs, and a later edit breaks it unnoticed in production terms. → Accepted: it is pinned by
  tests until the next major deletes it, and no production path can reach it.
- [Trade-off] `expansion_floor` is a parameter that does nothing. → Accepted for one major: its
  description says so, and removal is breaking.
- [Risk] A stale sentence survives the doc sweep (the last change's retrospective records one).
  → Mitigation: the sweep greps `expansion`, `expansionFloor`, `EXPANSION_WEIGHT`, `related`
  and `expansion_similarity` across all of `docs/`, `README.md`, `GLOSSARY.md`, `eval/` and
  `src/`, and the reviewer reads the diff of every doc.

## Migration Plan

N/A for deployment: no data, corpus or index change. The new profile applies when the server
restarts on the new version. Rollback is reverting the profile values. Acceptance is the
production fused deep eval on the owner's vault, before and after, aggregates in the PR.

## Open Questions

None blocking. The agent-level re-run of the personal vault × Opus A/B cell is the owner's
separate decision.
