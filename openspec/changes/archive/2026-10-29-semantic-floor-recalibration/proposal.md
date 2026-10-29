Tracked by: #230

## Why

`search_notes` returns notes for every query the vault cannot answer: on the owner's vault, all 17
control queries of the extended eval (#220) return something, 3.53 notes on average at quick and 12
at deep. `harrier-270m`'s default floors (quick 0.2, deep 0.13) sit below its junk level, since every
control's semantic top-1 scores 0.32–0.56. Raising them alone changes nothing, because the one-shot
fallback retry at 0.05 refills every string the floor empties. Noise, not ranking, is the dominant
failure (#221), and the floor is the cheapest lever on it. Simulated through the real pipeline, a
0.45 floor without fallback takes controls returning anything from 17 to 6 at both efforts, with
answerable hit@3 held.

## What Changes

**`harrier-270m` semantic floors**
- From: quick 0.2, deep 0.13, fallback 0.05.
- To: quick 0.45, deep 0.45, no fallback.
- Reason: the decision on #222; at 0.45 control noise drops by about two thirds at no hit@3 cost.
- Impact: non-breaking. Default `search_notes` calls under `harrier-270m` return fewer, stronger
  semantic hits; a string with no hit above 0.45 gets an honest zero from the semantic leg.

**Fallback retry**
- From: every profile carries a fallback floor, and a default-threshold call that finds nothing
  retries once at it.
- To: the fallback is an optional profile field. The retry runs only under a profile that has one.
  `granite-97m` (0.65) and `harrier-0.6b` (0.15) keep theirs.
- Reason: with any fallback the raised floor does nothing.
- Impact: non-breaking. `query_stats.<q>.semantic_fallback` is already absent in most cases; under
  a profile without a fallback it never appears.

**Block-evidence floor**
- From: the deep block-evidence pass filters at the profile's `deep` floor.
- To: it filters at its own profile field, `blockFloor`, holding today's `deep` value per profile.
- Reason: a 0.45 note floor would otherwise thin `blocks[]`.
- Impact: none observable. Block selection is unchanged on every profile.

**Descriptions, docs and eval**
- The `threshold` description states the retry only for a profile that has one.
- The thresholds tables, the guide and the retrieval-policy doc are updated; GLOSSARY gains
  *Semantic floor*.
- The eval echoes the block floor in its report `config`. `--stats` reports a fallback pass rate
  only for a profile with a fallback.

Out of scope: recalibrating `granite-97m` or `harrier-0.6b`, a language-aware floor,
`expansionFloor`, and `EXPANSION_WEIGHT` (#232).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `embedding-model-profiles`: the similarity defaults a profile carries. The fallback becomes
  optional, and the block-evidence floor becomes its own default instead of the deep default.
- `hybrid-search`: the default-only fallback retry runs only when the active profile defines a
  fallback, and the deep block-evidence pass filters at the profile's block-evidence floor.
- `retrieval-eval`: calibration statistics record a fallback pass rate only for a profile with a
  fallback, and a baseline is checked only on the defaults the current profile defines.

## Impact

- Code: `src/lib/model-profiles.ts` (`SimilarityDefaults`, the three profiles),
  `src/modules/semantic/retrieval-policy.ts` (fallback branch, block pass),
  `src/modules/semantic/search-observability.ts` and `tools/search-notes.ts` (fallback threshold
  plumbing and the `threshold` description), `eval/pipelines.ts` and `eval/stats.ts`/`eval/run.ts`
  (report config, `--stats` over an optional default).
- Tests: model-profile registry invariants, retrieval policy, observability, the `threshold`
  description, eval config and stats.
- Docs: `docs/guide/finding-notes.md`, `docs/guide/embedding-models.md`,
  `docs/guide/configuration.md`, `docs/architecture/retrieval-policy.md`, `eval/README.md`,
  `GLOSSARY.md`.
- No API or dependency change; the `search_notes` response shape is unchanged.
