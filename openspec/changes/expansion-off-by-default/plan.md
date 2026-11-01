# Expansion off by default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No `search_notes` call runs the expansion leg: `EFFORT_PROFILES.deep` switches it off,
the tool contract loses `"expansion"` provenance and `expansion_similarity`, `expansion_floor`
stays accepted and inert, and every document and test agrees.

**Architecture:** The policy (`executeRetrieval`) reads `expansion` / `expansionLimit` from
`EFFORT_PROFILES` through `MODE_DEFAULTS`; flipping the deep profile stops the step for every
caller (design D1). The step stays behind `RetrievalInput.expansion` for the policy tests and the
parity oracle (D3). The pipeline and `fuseRanks` keep the third source as always-empty data. The
tool layer narrows its types (D3). The eval follows the profile and drops the one `--stats`
population that mirrored the leg (D4).

**Tech Stack:** TypeScript ESM, vitest, zod (via the registration gate).

**Spec:** `specs/hybrid-search/spec.md`, `specs/retrieval-eval/spec.md`,
`specs/embedding-model-profiles/spec.md`, `specs/corpus-staleness-filtering/spec.md`,
`specs/shared-corpus-reads/spec.md` (all MODIFIED) and `design.md` in this change.

**Execution:** native. This session implements every task, then one fresh whole-branch reviewer
reads the diff. Task 1 flips the value every other task's tests read; the rest are small.

## Global Constraints

- `EFFORT_PROFILES.deep`: `semanticPool: 8`, `lexicalNoteCap: 10`, `expansion: false`,
  `expansionLimit: 0`, `mergedCap: 12`. `quick` is unchanged.
- No change to `SimilarityDefaults`, the floors, `EXPANSION_WEIGHT`, `fuseRanks`,
  `flattenExpansion` or `computeRelatedPerSeed`.
- `expansion_floor` stays on the schema with the same zod shape; only its description changes.
- Tool tests go through `registerTool(...)` and `callTool`, never `.handler` (ADR-0015).
- No private vault content in any file, commit or PR: aggregate numbers only.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run format` pass before each commit.
  Commit bodies have lines of 100 characters or fewer and one `Co-Authored-By` trailer.

## Review Focus

1. A deep call with an explicit `expansion_floor` must return exactly what the same call
   without it returns (Task 2, the inert test).
2. No `nearest` read anchored on a seed path happens in production: pinned by the parity
   "one call per step" test (one `nearest` call for three deep queries) and the eval's
   "runs the legs with the knobs its config records" test (Task 1, Task 3).
3. The tool's `found_in` type has four values and the entry type has no `expansion_similarity`;
   `tsc --noEmit` is the check (Task 2).
4. `--stats` still reports the `expansionFloor` pass rate on `seed_all` (Task 3).
5. The description budget (4,050 characters) still holds and the description no longer
   mentions expansion anywhere (Task 2).

---

### Task 1: Profile and policy

**Files:**
- Modify: `src/modules/semantic/effort-profiles.ts`, `src/modules/semantic/retrieval-policy.ts`
  (comments only)
- Test: `test/semantic/effort-profiles.test.ts`, `test/semantic/calibration-curve.test.ts`,
  `test/semantic/retrieval-parity.test.ts`, `test/semantic/retrieval-policy.test.ts`

- [ ] **Step 1:** Change the pin in `effort-profiles.test.ts` to `expansion: false,
  expansionLimit: 0` for `deep`. Run `npx vitest run test/semantic/effort-profiles.test.ts`:
  FAIL.
- [ ] **Step 2:** Flip the profile; update the field comment ("Whether the expansion leg runs at
  this effort. Off in every profile since #270 …"), the `RetrievalInput.expansion` comment and
  the step 5 comment. Run the file: PASS.
- [ ] **Step 3:** `calibration-curve.test.ts`: rename the deep-default cases ("no expansion"),
  assert every `related` is empty, regenerate the two inline snapshots
  (`npx vitest run test/semantic/calibration-curve.test.ts -u`) and read the diff: only
  `related` moved to `[]`. The floor case and the threshold-decoupling case pass
  `expansion: true, expansionLimit: 3`.
- [ ] **Step 4:** `retrieval-parity.test.ts`: add an `EXPANSION` axis to the matrix
  (`['profile default', undefined]`, `['explicit expansion', { expansion: true, expansionLimit: 3 }]`)
  threaded through `legacyRun` and the composed call; the "exercises every step" pin keeps its
  `related` assertion; the "one nearest call carries every query vector" test expects one call.
- [ ] **Step 5:** `retrieval-policy.test.ts`: the profile-defaults test and any test expecting an
  expansion read under deep defaults pass the explicit input; a new test pins that deep defaults
  make no seed-anchored read and leave `related` empty. Run `npx vitest run test/semantic/`:
  PASS. Commit `feat(semantic): switch the expansion leg off in the deep profile`.

### Task 2: Tool contract

**Files:**
- Modify: `src/modules/semantic/tools/search-notes.ts`, `src/modules/semantic/retrieval-pipeline.ts`
  (comments)
- Test: `test/semantic/tools/search-notes.test.ts`, `test/semantic/tools/search-notes-hybrid.test.ts`,
  `test/semantic/tools/search-notes-description.test.ts`, `test/semantic/retrieval-pipeline.test.ts`

- [ ] **Step 1:** `search-notes.test.ts`: replace the four deep-expansion tests with two
  (single-query and multi-query deep): the neighbour-only note is absent, no entry has
  `"expansion"` in `found_in`, no entry has an `expansion_similarity` key, the seed keeps
  `found_in: ["semantic"]`. `search-notes-hybrid.test.ts`: the "wiring" describe becomes
  "expansion_floor is inert": deep with `0.9` and without are `toEqual`; the arity test drops
  the expansion precondition. `search-notes-description.test.ts`: effort line without
  "expansion on" / "no expansion", no `expansion_similarity` line, `expansion_floor`
  description contains "no effect" and "next major" and no digit. Run the three files: FAIL.
- [ ] **Step 2:** Edit `search-notes.ts` (types, mapping, description, two field descriptions).
  Run the three files and `npm run typecheck`: PASS.
- [ ] **Step 3:** `retrieval-pipeline.test.ts`: the first test asserts no candidate carries
  `expansion` and n8 is absent while n9 (lexical) is present; the existence-filter test drops
  its `related` loop. Update the `retrieval-pipeline.ts` existence-check comment. Run the file:
  PASS. Commit `feat(search): drop expansion provenance from the search_notes contract`.

### Task 3: Eval

**Files:**
- Modify: `eval/stats.ts`, `eval/run.ts`, `eval/pipelines.ts` (comments)
- Test: `test/eval/stats.test.ts`, `test/eval/pipelines.test.ts`, `test/eval/run.test.ts`

- [ ] **Step 1:** `stats.test.ts`: remove `expansionLimit` from the shape and the
  `expansion_neighbours` assertion; assert the populations object has no such key.
  `pipelines.test.ts`: deep config `expansion: false, expansion_limit: 0`; the fan test asserts
  no candidate carries `expansion`; the knobs test asserts `nearest` was called once with the
  seed options. Run: FAIL.
- [ ] **Step 2:** Remove the population and the argument; adjust the comments. Run
  `npx vitest run test/eval/` and `npm run typecheck`: PASS. Commit
  `feat(eval): follow the retired expansion leg`.

### Task 4: Docs

**Files:** the list in tasks 4.1.

- [ ] **Step 1:** Edit each file. The guide and README say deep runs no expansion and that
  `expansion_floor` is inert; the architecture pages keep their mechanism sections headed as
  retired; the dictionary rows for `threshold` and `expansion_floor` follow; `GLOSSARY.md`'s
  semantic-leg entry loses "and expansion neighbours"; `eval/README.md` loses the
  `expansion_neighbours` row and the "expansion (at deep effort)" prose.
- [ ] **Step 2:** `grep -rn -i 'expansion\|EXPANSION_WEIGHT\|expansion_similarity\|\brelated\b' docs README.md GLOSSARY.md eval src --include='*.md' --include='*.ts'`
  and read every line. Run `npm run format`. Commit
  `docs(search): the expansion leg is off in every effort`.

### Task 5: Measure, verify, archive

- [ ] **Step 1:** `npm test && npm run lint && npm run typecheck && npm run format && npm run build`
  and `npx commitlint --from origin/main --to HEAD`.
- [ ] **Step 2:** `npx tsx eval/run.ts --vault <owner vault> --run production --pipeline fused --effort deep`
  on the branch; compare with the baseline in design §Context.
- [ ] **Step 3:** Dispatch one fresh reviewer over `origin/main..HEAD`; fix what it finds.
- [ ] **Step 4:** Write `verify.md` and `retrospective.md`; `openspec archive expansion-off-by-default`
  (syncs the delta specs); commit; push; `gh pr create` with `Closes #270`.
