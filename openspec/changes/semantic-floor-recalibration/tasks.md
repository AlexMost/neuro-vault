# Tasks — semantic-floor-recalibration

One PR, `Closes #230`. Group 1 comes first: it changes the `SimilarityDefaults` type, and every
other group compiles against it. Groups 2, 3 and 4 touch disjoint files, so they are parallel-safe
with each other once group 1 is in. Group 5 needs 1–4. Group 6 is last.

## 1. Profile shape and values (sequential, first)

- [x] 1.1 `SimilarityDefaults` (`src/lib/model-profiles.ts`): `fallback` becomes optional, and a
      required `blockFloor` is added (design D3, D4). Profile values: `harrier-270m` quick 0.45,
      deep 0.45, no fallback, blockFloor 0.13; `granite-97m` blockFloor 0.66; `harrier-0.6b`
      blockFloor 0.19; everything else unchanged. Every `SimilarityDefaults` literal in tests
      gains a `blockFloor` (`test/_identity.ts` `TEST_SIMILARITY` at its `deep` value 0.35, so
      fixtures keep their meaning). `test/semantic/model-profiles.test.ts`: the pin holds the new
      values, and the ordering test checks `deep > fallback` only where a fallback exists.

## 2. Retrieval policy (needs 1; parallel-safe with 3 and 4)

- [x] 2.1 `executeRetrieval`: the fallback retry runs only when `similarity.fallback` is defined.
      Test: under defaults with no fallback, a query left empty by the default gets zero hits,
      one note read is made, and `per_query_fallback` is false.
- [x] 2.2 `executeRetrieval`: the deep block pass filters at `similarity.blockFloor`. Test: with
      `blockFloor` distinct from `deep`, the deep block read carries `blockFloor`; quick's block
      read still carries 0.

## 3. Tool surface and observability (needs 1; parallel-safe with 2 and 4)

- [x] 3.1 `search-observability.ts`: `fallbackThreshold` becomes optional in the observability
      context. `search_notes` passes `similarity.fallback` through unchanged. Test: a context
      without a fallback threshold derives `query_stats` with no `semantic_fallback` key and no
      note.
- [x] 3.2 `search_notes` `threshold` description (design D5). With a fallback it reads as today.
      Without one it states the quick and deep defaults, says there is no retry, and names no
      fallback value. Test through the advertised schema (post-gate) for both shapes. The source
      grep test follows the new interpolation.

## 4. Eval (needs 1; parallel-safe with 2 and 3)

- [x] 4.1 `evalConfig` (`eval/pipelines.ts`) echoes `block_floor`; `fallback_threshold` is null
      under a profile without a fallback. Tests in `test/eval/pipelines.test.ts`.
- [x] 4.2 `--stats` (`eval/stats.ts`, `eval/run.ts`): `DefaultKey` excludes `blockFloor`; pass
      rates and suggestions cover the defaults the profile defines; `--baseline` validation
      checks only those. Tests: a profile without a fallback has no `fallback` pass rate; a
      baseline carrying `fallback` is accepted under it; a baseline missing a defined default is
      still refused.

## 5. Docs (needs 1–4)

- [x] 5.1 Thresholds tables and prose (design D7): `docs/guide/embedding-models.md`,
      `docs/guide/finding-notes.md`, `docs/guide/configuration.md`,
      `docs/architecture/retrieval-policy.md` (conditional retry, block floor, calibration
      provenance for `harrier-270m`), `eval/README.md` (`--stats` and the block floor).
      `GLOSSARY.md` gains *Semantic floor*. A sweep of all of `docs/` for the old values and for
      "block-evidence floor = deep".

## 6. Measure, verify, archive (sequential, last)

- [ ] 6.1 Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`,
      `npm run build`, `npx commitlint --from origin/main --to HEAD`.
- [x] 6.2 After-eval on the owner's vault, production fused quick and deep. Record aggregate
      deltas against the baseline in design §Context (controls, hit@3, R@10), and confirm the
      guard: no answerable loss beyond the one accepted cross-language entry.
- [ ] 6.3 verify → retrospective → archive (`openspec archive semantic-floor-recalibration`) →
      PR with `Closes #230`.
