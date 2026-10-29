# Semantic floor recalibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `harrier-270m`'s default semantic floors become quick 0.45 / deep 0.45 with no fallback,
the fallback becomes an optional profile field, and the deep block-evidence pass gets its own
`blockFloor`, so control-query noise drops without thinning `blocks[]`.

**Architecture:** All values live in `SimilarityDefaults` (`src/lib/model-profiles.ts`), read by
`executeRetrieval`. The retry branch runs only when the profile defines `fallback` (design D3). The
deep block pass reads `similarity.blockFloor` (D4). The tool description (D5), the observability
context and the eval (D6) follow the optional field.

**Tech Stack:** TypeScript ESM, vitest, zod (via the registration gate).

**Spec:** `specs/embedding-model-profiles/spec.md`, `specs/hybrid-search/spec.md`,
`specs/retrieval-eval/spec.md` (all MODIFIED) and `design.md` in this change.

**Execution:** native. This session implements every task, then one fresh whole-branch reviewer
checks the branch. Task 1 changes a type that every other task compiles against, and the rest are
small.

## Global Constraints

- `harrier-270m`: `quick: 0.45`, `deep: 0.45`, no `fallback` key, `blockFloor: 0.13`. `expansionFloor`
  0.2, `similarNotes` 0.22 and `duplicates` 0.77 are unchanged.
- `granite-97m`: `blockFloor: 0.66`. `harrier-0.6b`: `blockFloor: 0.19`. No other value changes.
- The explicit `threshold` path is unchanged: a hard filter, no retry.
- Quick's block pass (threshold 0, limit 5) and the per-seed backfill (threshold 0, limit 1) are
  unchanged.
- Tool tests go through `registerTool(...)` and the advertised schema, never `.handler` directly
  (ADR-0015).
- No private vault content in any file, commit or PR: aggregate numbers only.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass before each commit. Commit
  bodies have lines of 100 characters or fewer and one `Co-Authored-By` trailer.

## Review Focus

1. A profile with a fallback must behave exactly as before. The existing fallback tests run on
   `TEST_SIMILARITY`, which keeps one, so they stay as the regression pin (Task 2).
2. A profile without a fallback must make no retry read, not a read at `undefined`. Pinned by
   counting `corpus.nearest` calls (Task 2).
3. An explicit `threshold` must not reach the block pass now that it has its own floor. The
   existing "filters deep blocks at the internal default" test, with `blockFloor` equal to `deep`
   in `TEST_SIMILARITY`, plus the DISTINCT-defaults test where they differ (Task 2).
4. A `--baseline` report captured under the old `harrier-270m` (it has a `fallback` pass rate)
   must not be refused by a run under the new one (Task 4).
5. `formatStats` must not print a line for an absent `fallback` (Task 4).

---

### Task 1: Profile shape and values

**Files:**
- Modify: `src/lib/model-profiles.ts` (`SimilarityDefaults`, three profiles)
- Modify: `test/_identity.ts` (`TEST_SIMILARITY`)
- Modify: `test/semantic/model-profiles.test.ts`
- Modify (compile only): every other `SimilarityDefaults` literal: `test/semantic/retrieval-policy.test.ts`
  (`DISTINCT`), `test/semantic/tools/search-notes-description.test.ts`,
  `test/semantic/tools/threshold-description.test.ts`, `test/semantic/tools/find-duplicates.test.ts`,
  `test/semantic/tools/get-similar-notes.test.ts`

**Interfaces:**
- Produces: `SimilarityDefaults.fallback?: number` (doc: "One-shot retry floor when a default
  threshold finds nothing; absent = no retry, so zero hits are honest") and
  `SimilarityDefaults.blockFloor: number` (doc: "Deep block-evidence floor; independent of the note
  floors"). The `deep` doc comment drops "also the deep block-evidence floor".

- [ ] **Step 1:** Update the pin `CALIBRATED_SIMILARITY` in `model-profiles.test.ts` to the Global
  Constraints values (`harrier-270m` without a `fallback` key) and point its comment at this
  change's design as well as `calibration.md`. Change the ordering test to
  `'carries similarity defaults on every profile, ordered quick ≥ deep > fallback where one exists'`:
  `expect(quick).toBeGreaterThanOrEqual(deep)`, and `if (fallback !== undefined) expect(deep).toBeGreaterThan(fallback)`.
  Add `it('harrier-270m defines no fallback')`: `expect('fallback' in resolveModelProfile('harrier-270m').similarity).toBe(false)`.
- [ ] **Step 2:** Run `npx vitest run test/semantic/model-profiles.test.ts`. Expected: FAIL on the pin.
- [ ] **Step 3:** Change the type and the three profiles. Add `blockFloor: 0.35` to `TEST_SIMILARITY`
  (equal to its `deep`, so fixtures keep their meaning) and a `blockFloor` to every other literal
  (`DISTINCT` in retrieval-policy.test.ts gets `0.5`, distinct from its `deep` 0.6; the description
  tests' `distinct` objects get `0.33`).
- [ ] **Step 4:** Run `npx vitest run test/semantic/model-profiles.test.ts` and `npm run typecheck`.
  Expected: the profile test passes. Typecheck may fail only in `src/` sites that read
  `similarity.fallback` as a number (`retrieval-policy.ts`, `search-notes.ts`, `eval/`); those are
  Tasks 2–4. Commit Tasks 1–2 together if typecheck cannot pass in between
  (`feat(semantic): ...`).

### Task 2: Retrieval policy

**Files:**
- Modify: `src/modules/semantic/retrieval-policy.ts` (step 2 retry condition, step 4 block threshold)
- Test: `test/semantic/retrieval-policy.test.ts` (`describe('executeRetrieval — profile similarity defaults')`)

**Interfaces:**
- Consumes: Task 1's `SimilarityDefaults`.

- [ ] **Step 1:** In the profile-defaults describe, change the deep test to expect
  `['block', 0.5]` (DISTINCT's `blockFloor`) and rename it
  `"uses the profile's deep default for seeds, its block floor for block evidence, and its expansion floor"`.
  Add `it('makes no retry under a profile without a fallback')`: `NO_FALLBACK` is `DISTINCT` with
  the `fallback` key omitted (not set to `undefined`), the shape a real profile has. Queries
  `['q1', 'q2']`, mode `quick`, a corpus whose
  `findNeighbors` always returns `[]`. Assert `corpus.nearest` called once, every recorded threshold
  is `0.7`, `results` is `[]` and `per_query_fallback` is `{ q1: false, q2: false }`.
- [ ] **Step 2:** Run `npx vitest run test/semantic/retrieval-policy.test.ts`. Expected: the two
  tests fail (block at 0.6; a second read at `undefined`).
- [ ] **Step 3:** Step 2 retry runs only when `fallback !== undefined` (read it once into a local
  `const fallback = input.similarity.fallback`, keeping the `threshold > fallback` condition). Step 4's
  deep branch uses `input.similarity.blockFloor`. Update the step comments accordingly.
- [ ] **Step 4:** Run the file and `npm run typecheck` for `src/modules/semantic/`. Expected: PASS.

### Task 3: Tool surface and observability

**Files:**
- Modify: `src/modules/semantic/search-observability.ts` (`ObservabilityContext.fallbackThreshold`,
  `queryStatsNote`, `queryStatsEntry`)
- Modify: `src/modules/semantic/tools/search-notes.ts` (the `threshold` description)
- Test: `test/semantic/search-observability.test.ts`, `test/semantic/tools/search-notes-description.test.ts`

**Interfaces:**
- Produces: `ObservabilityContext.fallbackThreshold?: number` ("absent when the profile has no
  fallback; the retry then never fires"). `queryStatsNote`'s arg becomes `fallbackThreshold?: number`.
  A `fallback: true` with an absent threshold is unreachable; the note is still written only on
  `fallback`, using the value.

- [ ] **Step 1:** Observability test `'derives no fallback flag or note under a profile without a fallback'`:
  `multi(['a', 'b'], { fallbackThreshold: undefined })` built without the key, a semantic leg that
  ran with hits for `a` and 0 for `b` and `perQueryFallback` all false. Assert neither entry has
  `semantic_fallback`, and `a` has no `note`.
- [ ] **Step 2:** Description test: keep the existing advertised-schema assertion for a profile with
  a fallback (`'effort defaults (0.61 quick / 0.47 deep) with one retry at 0.42'`). Add one without:
  the `distinct` object minus `fallback`, assert the description contains
  `'effort defaults (0.61 quick / 0.47 deep) with no retry — zero hits are honest'` and does not
  contain `'retry at'`. The source-grep test replaces `'${similarity.fallback}'` with the
  interpolation the new code uses.
- [ ] **Step 3:** Run both files. Expected: the no-fallback description test fails.
- [ ] **Step 4:** Implement. The description's "Omitted:" sentence becomes
  `Omitted: effort defaults (${quick} quick / ${deep} deep) with one retry at ${fallback}.` when
  the profile has a fallback, and
  `Omitted: effort defaults (${quick} quick / ${deep} deep) with no retry — zero hits are honest.`
  when it does not. Build the clause in a small local helper or const beside the schema, not inline
  ternaries in the template.
- [ ] **Step 5:** Run both files and `npm run typecheck`. Expected: PASS.

### Task 4: Eval

**Files:**
- Modify: `eval/pipelines.ts` (`evalConfig`)
- Modify: `eval/stats.ts` (`DefaultKey`, `CalibrationStats`, `computeCalibrationStats`, new `measuredKeys`)
- Modify: `eval/run.ts` (`readBaseline`, its call site, `formatStats`)
- Test: `test/eval/pipelines.test.ts`, `test/eval/stats.test.ts`, `test/eval/run.test.ts`

**Interfaces:**
- Produces:
  - `export type DefaultKey = Exclude<keyof SimilarityDefaults, 'blockFloor'>` (comment: "the
    block floor's population, query↔every block, is not collected").
  - `export function measuredKeys(similarity: SimilarityDefaults): DefaultKey[]`: the
    `DEFAULT_KEYS` the profile defines, in `DEFAULT_KEYS` order.
  - `CalibrationStats.pass_rates` and `suggested` keep every `DefaultKey` required except
    `fallback`, which is optional (for example `Omit<Record<DefaultKey, PassRate>, 'fallback'> & { fallback?: PassRate }`).
  - `readBaseline(file: string, similarity: SimilarityDefaults)`.
  - `evalConfig` gains `block_floor: similarity.blockFloor` after `expansion_floor`, and
    `fallback_threshold: positional ? null : (similarity.fallback ?? null)`.

- [ ] **Step 1:** Tests.
  - `pipelines.test.ts`: `'a production run under a profile without a fallback records a null fallback'`:
    `evalConfig(NO_FALLBACK, { run: 'production', effort: 'quick' })` has `fallback_threshold: null`.
    Add `block_floor: TEST_SIMILARITY.blockFloor` to the existing production expectation.
  - `stats.test.ts`: the `DEFAULT_KEYS` test expects `Object.keys(TEST_SIMILARITY)` minus
    `blockFloor`. New `'measures no fallback for a profile without one'`: `computeCalibrationStats`
    with `TEST_SIMILARITY` minus `fallback` has no `pass_rates.fallback` and does have `pass_rates.deep`;
    with a baseline, `suggested` has no `fallback` either. `measuredKeys` of that profile is
    `DEFAULT_KEYS` without `'fallback'`.
  - `run.test.ts`: `'accepts a baseline carrying a default the current profile does not define'`:
    capture a `--stats` report under `GRANITE` (it has a fallback), then run with `--baseline` under
    a test profile without a fallback (spread `GRANITE` with its `similarity` minus `fallback`);
    the run succeeds and its `suggested` has no `fallback`. The existing missing-`duplicates` refusal
    test stays as is.
- [ ] **Step 2:** Run the three files. Expected: the new tests fail.
- [ ] **Step 3:** Implement. `computeCalibrationStats` and the `suggested` block iterate
  `measuredKeys(args.similarity)`. `readBaseline` validates only `measuredKeys(similarity)`. The
  call site passes `profile.similarity`. `formatStats` already iterates `Object.entries(stats.pass_rates)`,
  so an absent key prints nothing; keep it that way.
- [ ] **Step 4:** Run `npx vitest run test/eval` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit Tasks 1–4 (or 3–4 if 1–2 were committed):
  `feat(semantic): recalibrate harrier-270m floors, optional fallback, own block floor`, body naming
  the values and `Refs #230`.

### Task 5: Docs and glossary

**Files:**
- Modify: `docs/guide/embedding-models.md` (thresholds table at ~line 100, the "six defaults"
  sentence, line 111's "quotes … fallback")
- Modify: `docs/guide/finding-notes.md` (lines ~23, 50, 120, 172–197, 241–250)
- Modify: `docs/guide/configuration.md` (lines ~27, 116)
- Modify: `docs/architecture/retrieval-policy.md` (steps 1 and 3, the defaults table at ~185, the
  values table at ~195, the `quick ≥ deep > fallback` line, a calibration-provenance paragraph)
- Modify: `eval/README.md` (`--stats` pass rates, report `config`)
- Modify: `GLOSSARY.md` (Retrieval section)

- [ ] **Step 1:** Tables: `harrier-270m` quick 0.45, deep 0.45, fallback "—" (none); a `blockFloor`
  row (0.13 / 0.66 / 0.19, "deep block-evidence floor"); the `deep` row loses "also the
  block-evidence floor". "Six calibrated defaults" becomes seven, with the fallback optional.
- [ ] **Step 2:** Prose: every "with a one-shot retry at `fallback`" says it applies when the active
  model has a fallback, and that the default model has none. Every "blocks are filtered at the
  model's `deep` default" names the block-evidence floor instead. `configuration.md` line 27's
  example value ("`harrier-270m`'s `quick` is 0.20") becomes 0.45. The retrieval-policy doc gains
  the calibration provenance for `harrier-270m`: set on the extended eval's control queries (#222),
  not by bge pass-rate matching; the other two profiles keep the ADR-0017 method.
- [ ] **Step 3:** GLOSSARY: add **Semantic floor** under Retrieval, in the file's entry style: the
  lowest query↔note similarity at which a note counts as a semantic hit, set per model profile and
  effort; the block-evidence floor is separate. _Avoid_: threshold (that is the caller's parameter).
- [ ] **Step 4:** Sweep: `grep -rn "0\.13\|0\.20\b\|0\.05\|fallback\|block-evidence" docs eval/README.md GLOSSARY.md README.md`
  and fix every stale statement about `harrier-270m` or the block floor. ADRs and archived changes
  are immutable and stay as written.
- [ ] **Step 5:** `npm run format`, then commit `docs(semantic): document the recalibrated floors`
  with `Refs #230`.

### Task 6: Measure, verify, archive, PR

- [ ] **Step 1:** Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`,
  `npm run build`. Expected: all pass.
- [ ] **Step 2:** After-eval: `npm run eval -- --vault <vault> --run production --pipeline fused --effort quick`
  and `--effort deep`. Compare against design §Context. Pass: controls returning anything well
  below 17 at both efforts; answerable hit@3 and R@10 not below the baseline beyond the one accepted
  cross-language entry. Aggregate numbers only.
- [ ] **Step 3:** Whole-branch review by one fresh reviewer; address findings.
- [ ] **Step 4:** `/opsx:verify` → `verify.md`; `retrospective.md`; `npx openspec archive semantic-floor-recalibration -y`;
  commit; `npx commitlint --from origin/main --to HEAD`.
- [ ] **Step 5:** Push and `gh pr create` with `Closes #230`, the before/after table and the guard
  verdict. Stop for the owner's review.
