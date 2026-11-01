Tracked by: #270

## Why

At `effort: "deep"`, `search_notes` adds an expansion leg: up to three embedding neighbours of
every semantic seed, fused as a third rank source. Measured through the production pipeline on
two private golden sets (the owner's vault, 63 answerable and 17 control entries; a corporate
vault pair, 30 entries), notes that only this leg returned were relevant 3 times in 78 (4 %) and
1 time in 128 (1 %). Switching it off raises list precision by 0.03 and 0.045, cuts notes per
answer by 10–20 % and notes on no-answer control entries by a quarter to a half, with MRR
unchanged and recall down by 0.016 and 0.005, inside the confidence interval on both vaults.
Graph neighbours measured the same, so the leg goes, not its neighbour source.

## What Changes

**Expansion leg**
- From: runs at `effort: "deep"` (`EFFORT_PROFILES.deep`: `expansion: true, expansionLimit: 3`),
  off at `quick`.
- To: off at every effort (`deep`: `expansion: false, expansionLimit: 0`). No `matches[]` entry
  carries `"expansion"` in `found_in` or an `expansion_similarity` field; `search_notes` ranks by
  RRF over the semantic and lexical legs.
- Reason: the measurement above (#270).
- Impact: non-breaking for callers. A deep call returns fewer, more precise notes; the response
  shape loses only a provenance value and a field that no longer have a producer.

**`expansion_floor`**
- From: bounds the expansion leg at `deep`; inert at `quick` and in `mode: "lexical"`.
- To: accepted and inert everywhere, with a schema description that says so and names its
  removal at the next major. Dropping it now would be a breaking change (ADR-0005).
- Impact: non-breaking. A caller that passes it gets the same result as one that does not.

**Mechanism**
- The policy keeps its expansion step behind `RetrievalInput.expansion`, which no profile and no
  caller sets; `runRetrievalPipeline` and `fuseRanks` keep the third source as data (always
  empty). Deleting the mechanism and the parameter is the follow-up for the next major.

**Eval and docs**
- `evalConfig` follows the profile; reports record `expansion: false, expansion_limit: 0` and
  keep the `diagnostics.*.expansion` counter (0) for before/after reads. `--stats` drops the
  `expansion_neighbours` population; `seed_all` keeps measuring the `expansionFloor` pass rate.
- The tool description, `docs/guide/`, `docs/architecture/`, `GLOSSARY.md`, `README.md` and
  `eval/README.md` say deep runs no expansion.

Out of scope: an opt-in parameter, a different neighbour source, deleting the mechanism,
re-tuning `EXPANSION_WEIGHT`, any reindex (`embed_version` is unchanged: ranking, not vectors),
and the agent-level A/B re-run (owner's call, separate).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `hybrid-search`: no effort runs the expansion leg; `found_in` and the entry fields lose
  expansion provenance; `expansion_floor` becomes accepted-and-inert; fusion is over two sources;
  the flattened-third-source requirement is removed.
- `retrieval-eval`: the `fused` pipeline is the fusion of the semantic and lexical legs; the
  report still records the profile's `expansion_floor`; `--stats` has six distributions, not
  seven.
- `embedding-model-profiles`: `expansionFloor` stays a profile default for the eval's
  calibration statistics; no tool applies it.
- `corpus-staleness-filtering`: `search_notes`' existence check binds semantic seeds; the
  expansion-target scenario goes.
- `shared-corpus-reads`: the composed semantic leg expands only when its input asks to, which no
  effort profile does.

## Impact

- Code: `src/modules/semantic/effort-profiles.ts` (the deep profile),
  `src/modules/semantic/tools/search-notes.ts` (description, `expansion_floor` description,
  `found_in` / entry type, response mapping), `src/modules/semantic/retrieval-policy.ts` and
  `retrieval-pipeline.ts` (comments only), `eval/stats.ts` and `eval/run.ts` (the dropped
  population).
- Tests: the effort-profile pin, the policy, parity, calibration-curve and pipeline tests
  (explicit `expansion` input where they pin the retired step), the tool tests through the
  registration gate (default: no expansion; `expansion_floor` inert at deep), the description
  tests, the eval config and stats tests.
- Docs: `docs/guide/finding-notes.md`, `embedding-models.md`, `configuration.md`,
  `docs/architecture/retrieval-policy.md`, `rank-fusion.md`, `mcp-parameter-dictionary.md`,
  `README.md` (map), `GLOSSARY.md`, `README.md`, `eval/README.md`.
- No dependency change, no corpus change, no version bump beyond the release flow.
