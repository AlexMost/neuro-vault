## Context

`search_notes`' semantic leg filters query↔note similarities at a per-profile floor: the profile's
`quick` or `deep` value when the caller omits `threshold`. Under a default threshold, a string the
floor leaves empty is retried once at the profile's `fallback`. The deep block-evidence pass reuses
the `deep` value as its floor. All of it lives in `SimilarityDefaults` (`src/lib/model-profiles.ts`)
and is read by `executeRetrieval` (`src/modules/semantic/retrieval-policy.ts`).

The `harrier-270m` values (quick 0.2, deep 0.13, fallback 0.05) were set by matching pass rates
against the retired bge-micro defaults ([ADR-0017](../../../docs/adr/0017-embedding-model-profiles.md)).
The extended eval (#220) shows they never fire. Every control query's semantic top-1 is 0.32–0.56,
and all 17 controls return notes in production at both efforts. The miss analysis (#221) puts noise,
not ranking, as the dominant failure. The wayfinder map #216 grilled the options through the real
pipeline (production effort, uncapped fused list, rule applied, then the merged cap) and decided
the rule on #222, with #224 folded in.

Baseline on `main` at the start of this change (production, fused, harrier-270m, 80-entry golden
set: 63 answerable, 17 controls):

| effort | hit@3 | R@10 | controls returning anything | mean notes on controls |
|---|---|---|---|---|
| quick | 0.937 | 0.672 | 17 of 17 | 3.53 |
| deep | 0.889 | 0.859 | 17 of 17 | 12.0 |

Deep hit@3 reads 0.889 here against 0.905 in the #220 baseline because the vault moved between the
two runs. The guard is read against this run.

## Goals / Non-Goals

**Goals:**

- Default `search_notes` calls under `harrier-270m` stop returning semantic junk for strings the
  vault cannot answer: controls returning anything move from 17 of 17 toward the simulated 6.
- Answerable hit@3 and recall@10 hold at both efforts, except for the one cross-language entry the
  decision accepts.
- `blocks[]` is unchanged on every profile.
- `granite-97m` and `harrier-0.6b` behave exactly as before.

**Non-Goals:**

- Recalibrating `granite-97m` or `harrier-0.6b`. That belongs to the change that makes one of them
  the default.
- A language-aware floor, `expansionFloor`, or `EXPANSION_WEIGHT` (#232).
- Any change to the explicit `threshold` parameter or to the response shape.

## Decisions

### D1: One scalar floor per profile and effort, recalibrated

- **Choice:** keep the existing rule, one scalar default floor on the semantic leg's note scores
  per profile and effort, and raise its value. A two-leg note under the floor still arrives
  through the lexical leg. In deep, a weak seed drops before expansion, so its recruited
  neighbours go with it.
- **Why:** it is the one option that cuts control noise at both efforts without losing hit@3
  (table on #222).
- **Alternatives considered:**
  - A bar on semantic-only hits inside fusion. It equals the floor at quick, but in deep the freed
    slots backfill with expansion and controls stay at 17 of 17.
  - Demoting semantic-only hits in RRF (×0.5). Lexical junk rises above real semantic hits; hit@3
    falls to 0.873 (quick) and 0.746 (deep).
  - A relative cut at top-1 − δ. Control lists are flat, so it separates nothing.
  - A `min_legs` filter parameter (#224). `found_in` already tells the agent, and the floor removes
    the same noise without a contract change.

### D2: `harrier-270m` floors are quick 0.45 and deep 0.45

- **Choice:** both efforts at 0.45, so quick and deep then differ only by pool sizes and expansion.
- **Why:** 0.45 is where controls returning anything drop to 6 with quick hit@3 at 0.937. At 0.40,
  12 controls still return notes and hit@3 drops to 0.921.
- **Alternatives considered:** a lower deep floor, as today's shape has. Deep's extra pool already
  widens recall, and a lower deep floor lets junk seeds recruit expansion neighbours.
- The value was picked on the same 63 answerable entries it is checked on: quick hit@3 moves within
  0.905–0.937 across 0.42–0.48. The epic carries a re-check for the next golden-set revision.

### D3: The fallback is an optional profile field

- **Choice:** `SimilarityDefaults.fallback` becomes optional. `executeRetrieval` runs the retry only
  when the profile defines one, under the existing conditions (default threshold, a string left
  empty, the default above the fallback). `harrier-270m` defines none; `granite-97m` keeps 0.65 and
  `harrier-0.6b` keeps 0.15.
- **Why:** with the fallback kept at 0.05, the 0.45 floor does nothing (#222 table, row 2): every
  string it empties is refilled by the retry.
- **Alternatives considered:**
  - Keep a fallback but raise it, for example to 0.40. That puts back junk exactly where the floor
    removed it, on strings with no hit above 0.45, which are the control strings.
  - Remove the fallback from every profile. That recalibrates the other profiles without measuring
    them, against Non-Goals.
- The observability context carries the fallback threshold as optional too. The `semantic_fallback`
  key and its note appear only when a retry produced hits, which needs a fallback to exist, so the
  note never reads an absent value.

### D4: The deep block-evidence floor is its own profile field, `blockFloor`

- **Choice:** a new required `SimilarityDefaults.blockFloor`, read by the deep block pass (step 4 of
  `executeRetrieval`) in place of `similarity.deep`. Every profile's value is its current `deep`:
  `harrier-270m` 0.13, `granite-97m` 0.66, `harrier-0.6b` 0.19. Quick's block pass (threshold 0,
  limit 5) and the per-seed backfill are unchanged.
- **Why:** the block pass shares the note floor only by coincidence of the original calibration. At
  0.45 it would thin `blocks[]` for the seeds that survive, which is not what the decision measured
  or wants.
- **Name:** `blockFloor`, after `expansionFloor`: a floor owned by one pass. It is internal, not a
  tool parameter, so the MCP parameter dictionary is not involved.
- **Alternatives considered:** deriving the block floor from `deep` with a constant. It is not on the
  same population (query↔block, not query↔note), and a per-profile value is how the registry carries
  every other default.

### D5: The `threshold` description states the retry only when there is one

- **Choice:** the `search_notes` `threshold` description keeps its interpolated defaults. With a
  fallback it reads as today, "with one retry at …". Without one, it says the defaults apply with
  no retry, so zero hits are honest.
- **Why:** the description tells the model what the server applies (ADR-0010; the profile spec's
  "descriptions state the active value"). A retry value that does not exist would be a lie.

### D6: The eval follows the profile

- **Choice:**
  - `evalConfig` echoes `block_floor` beside `expansion_floor`. `fallback_threshold` is already
    null-capable; it becomes null on a production run under a profile without a fallback.
  - `--stats` measures pass rates for the defaults the profile defines. A profile without a
    fallback gets no `fallback` pass rate or suggestion.
  - A `--baseline` is checked only on the defaults the current profile defines, so a baseline
    captured under the old `harrier-270m` (which had a fallback) stays usable.
  - `blockFloor` is not a `--stats` default. Its population, query↔every block, is not collected,
    and measuring it on query↔note would report a pass rate for the wrong population.
- **Why:** `--stats` exists to calibrate the profile's own defaults. A default the profile does not
  have has nothing to calibrate, and a population `--stats` does not collect cannot calibrate one.
- **Alternatives considered:** collecting a query↔block population. That is new measurement code
  for a floor this change keeps at its old value.

### D7: Docs and glossary

- The thresholds tables (`docs/guide/embedding-models.md`, `docs/guide/finding-notes.md`,
  `docs/architecture/retrieval-policy.md`) gain a `blockFloor` row and show `harrier-270m`'s
  fallback as none.
- `docs/architecture/retrieval-policy.md` documents the conditional retry and the block floor in its
  step descriptions and states the new calibration provenance for `harrier-270m`.
- `docs/guide/finding-notes.md` and `docs/guide/configuration.md` describe the retry as
  profile-dependent.
- `GLOSSARY.md` gains *Semantic floor*: the lowest query↔note similarity at which a note counts as a
  semantic hit, set per model profile and effort. The block-evidence floor is separate.

## Risks / Trade-offs

- [Risk] One English concept entry is lost at 0.45: its relevant note sits at 0.33–0.37, and a lower
  bar for English strings brings all six English controls back. → Mitigation: accepted by the
  decision (#222, point 6). The PR reports it as the one allowed guard loss. A language-aware floor
  stays on the epic's not-yet-specified list.
- [Risk] The value was chosen and checked on the same 63 entries, so it may overfit. → Mitigation:
  the 0.42–0.48 sweep shows a shallow optimum, and the epic carries a re-check at the next golden-set
  revision.
- [Risk] Agents that relied on "the semantic leg always returns something" now see more zero-result
  calls under the default profile. → Mitigation: that is the intended honest zero. The lexical leg
  still runs, and `query_stats` keeps counting per string.
- [Trade-off] Quick and deep now share one floor. Deep can no longer reach weaker semantic notes than
  quick by default. → Accepted: deep's extra recall comes from its pools and expansion. A caller who
  wants weaker hits passes an explicit `threshold`.
- [Risk] A test asserts behaviour through `similarity.deep` on the block pass and keeps passing
  because values coincide. → Mitigation: the policy test uses defaults where `blockFloor` and `deep`
  differ, so it can tell the two apart.

## Migration Plan

N/A for deployment: there is no data or corpus change and no index rebuild. The new floors apply when
the server restarts on the new version. To roll back, revert the profile values. An explicit
`threshold` remains available to any caller who wants the old recall per call.

Acceptance is measured, before and after, with the production eval on the owner's vault:
`npm run eval -- --vault <vault> --run production --pipeline fused --effort quick|deep`. Aggregate
numbers go in the PR; reports stay in the vault's private repository.

## Open Questions

- **Does ADR-0017 need a successor ADR?** ADR-0017 records the calibration rule (pass-rate matching
  against bge-micro, `fallback` below `deep` on every profile). This change replaces that rule for
  `harrier-270m` with a control-noise floor measured on the extended eval and makes the fallback
  optional. Owner's call at review; if yes, it is ADR-0024 and lands in this change's PR.
