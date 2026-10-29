# Brainstorm — semantic-floor-recalibration

Tracked by #230. Epic #234. Decided on wayfinder map #216:
[Semantic floors for harrier-270m](https://github.com/AlexMost/neuro-vault/issues/222#issuecomment-6506888580)
and [Single-leg semantic hits](https://github.com/AlexMost/neuro-vault/issues/224#issuecomment-6506889490),
on the evidence of the [miss analysis](https://github.com/AlexMost/neuro-vault/issues/221#issuecomment-6500763183).

## Background

The extended eval (#220) shows production `search_notes` returns notes for every control query
(17 of 17; 3.53 notes at quick, 12 at deep). The default semantic floors of `harrier-270m`
(quick 0.2, deep 0.13, fallback 0.05) sit far below its junk level: every control's semantic
top-1 scores 0.32–0.56, so the floors never fire. Raising them alone does nothing either: the
one-shot fallback retry at 0.05 refills every string the floor empties.

Simulated through the real pipeline (production effort, uncapped fused list, rule applied, then
the merged cap), on the 80-entry golden set:

| production option | quick hit@3 / MRR | quick ctl any / mean | deep hit@3 / R@10 | deep ctl any / mean |
|---|---|---|---|---|
| as is | 0.937 / 0.827 | 17 / 3.53 | 0.905 / 0.860 | 17 / 12.0 |
| floor 0.45, fallback 0.05 kept | 0.937 / 0.827 | 17 / 3.53 | 0.905 / 0.855 | 17 / 12.0 |
| floor 0.45, no fallback | 0.937 / 0.844 | 6 / 1.29 | 0.905 / 0.841 | 6 / 2.29 |

## Decision log

**Q1: what is the rule?** One scalar default floor on the semantic leg's note scores, per
model profile, as today, at a recalibrated value. A two-leg note under the floor still arrives
through the lexical leg. In deep, a weak seed is dropped before expansion, so its neighbours go
with it.
- Rejected: a bar on semantic-only hits inside fusion. It equals the floor at quick, but deep
  backfills the freed slots with expansion (controls stay at 17 of 17).
- Rejected: demoting semantic-only hits in RRF (×0.5). Lexical junk rises above real semantic
  hits, and hit@3 falls to 0.873 at quick and 0.746 at deep.
- Rejected: a relative cut (top-1 − δ). Control lists are flat, so it separates nothing.
- Rejected: a `min_legs` filter parameter. `found_in` already tells the agent, and the floor
  removes the noise.

**Q2: which values?** `harrier-270m` quick **0.45** and deep **0.45**. With them, quick and
deep differ only by pool sizes and expansion. The value was picked on the same 63 answerable
entries: quick hit@3 moves within 0.905–0.937 across 0.42–0.48. Re-check it when the golden
set is next revised.

**Q3: what happens to the fallback?** It becomes an optional, per-profile field of
`SimilarityDefaults`. `harrier-270m` has none: a string with no semantic hit above the floor
gets an honest zero. `granite-97m` (0.65) and `harrier-0.6b` (0.15) keep theirs. The
`semantic_fallback` key in `query_stats` is already documented as absent in most cases. It
simply never appears under a profile without a fallback, so the response shape does not break.

**Q4: what about the block floor?** It is decoupled. The block-evidence pass in deep currently
filters at `similarity.deep` (`retrieval-policy.ts`, step 4). It gets its own profile field
holding today's `deep` value for each profile, so the higher note floor does not thin
`blocks[]`. Quick's block pass (threshold 0) is unchanged.

**Q5: what about other profiles?** They are untouched. They are calibrated on the eval by the
change that makes one of them the default.

**Q6: a language-aware floor?** No. The losses at 0.45 are English concept queries against
Ukrainian notes: relevant similarity 0.33–0.37, en hit@3 1.0 → 0.929, one entry. A lower bar
for English strings (0.32) restores that entry but brings all 6 English controls back, because
English junk sits in the same band.

**Q7: what does the explicit `threshold` parameter do?** It is unchanged: a hard filter with no
fallback, as today.

## Touchpoints (for design/plan)

- `src/lib/model-profiles.ts`: the `SimilarityDefaults` shape (`fallback` optional, a new
  block-floor field), the `harrier-270m` values, and the other profiles' block floor equal to
  their current `deep`.
- `src/modules/semantic/retrieval-policy.ts`: the fallback branch runs only when the profile
  has one, and the deep block pass reads the block floor.
- `src/modules/semantic/search-observability.ts`, `tools/search-notes.ts`: `fallbackThreshold`
  plumbing, the `threshold` description (it quotes "one retry at …"), and the fallback note
  text.
- `eval/pipelines.ts`: `evalConfig`'s `fallback_threshold` (already `null`-capable) and the
  block floor echoed into `config`.
- Docs: `docs/guide/finding-notes.md` (Tuning threshold, query_stats), the thresholds table in
  `docs/guide/embedding-models.md` and `finding-notes.md`, and
  `docs/architecture/retrieval-policy.md`.
- `GLOSSARY.md`: *Semantic floor*, the lowest query↔note similarity at which a note counts as
  a semantic hit, set per model profile and effort; the block-evidence floor is separate.

## Acceptance

- `npm test`, `npm run lint`, `npm run typecheck` and `npm run format` pass.
- Production eval on the owner's vault, quick and deep: control hit rate and control mean
  results move from 17/17 and 3.53 / 12.0 toward the simulated 6/17 and 1.29 / 2.29.
- Answerable hit@3 and recall@10 do not drop below 0.937 / 0.672 (quick) and 0.905 / 0.859
  (deep), beyond the one cross-language entry accepted in Q6.
- Aggregate numbers go in the PR; reports go in the vault's private repo.

## Out of scope

- Recalibrating `granite-97m` / `harrier-0.6b`.
- A language-aware floor.
- `expansionFloor` (it never binds for `harrier-270m`) and `EXPANSION_WEIGHT` (#232, after
  this change).
