# Tasks — expansion-off-by-default

One PR, `Closes #270`. Group 1 comes first: it flips the profile every other group's tests read.
Groups 2 and 3 touch disjoint files and are parallel-safe with each other once group 1 is in.
Group 4 needs 1–3. Group 5 is last.

## 1. Profile and policy (sequential, first)

- [x] 1.1 `EFFORT_PROFILES.deep` (`src/modules/semantic/effort-profiles.ts`) becomes
      `expansion: false, expansionLimit: 0` (design D1). The doc comments on the profile field, on
      `RetrievalInput.expansion` and on step 5 of `executeRetrieval` say the leg is off in every
      profile and reachable only through an explicit input (D3). Pin the values in
      `test/semantic/effort-profiles.test.ts`.
- [x] 1.2 Tests that pin the retired step ask for it explicitly (`expansion: true,
      expansionLimit: 3`): `test/semantic/calibration-curve.test.ts` (the deep-default cases now
      carry empty `related[]`; the floor and the threshold-decoupling cases ask to expand),
      `test/semantic/retrieval-parity.test.ts` (one explicit-expansion row in the matrix so the
      "exercises every step" pin still reaches it; the one-call-per-step test expects a single
      `nearest` read), `test/semantic/retrieval-policy.test.ts` (every deep-default test that
      expected an expansion read).

## 2. Tool contract (needs 1; parallel-safe with 3)

- [x] 2.1 `src/modules/semantic/tools/search-notes.ts`: `found_in` and the entry type lose
      `"expansion"` and `expansion_similarity`, the response mapping drops the expansion branch,
      the description's first line and effort line say nothing of expansion and the
      `expansion_similarity` RESPONSE SHAPE line goes; the `threshold` description drops "or
      expansion leg"; the `expansion_floor` description says the value has no effect, names its
      removal at the next major and quotes no default (D2, D3). Tests through the registration
      gate: `test/semantic/tools/search-notes.test.ts` (deep, single- and multi-query: a note
      reachable only as a seed's neighbour is absent and no entry carries expansion provenance),
      `test/semantic/tools/search-notes-hybrid.test.ts` (the schema still advertises and
      validates `expansion_floor`; at deep the matches with and without it are identical; the
      arity test keeps its block precondition and drops the expansion one),
      `test/semantic/tools/search-notes-description.test.ts` (the new effort wording, no
      `expansion_similarity` line, the inert `expansion_floor` text, the source no longer
      interpolates `similarity.expansionFloor`).
- [x] 2.2 `test/semantic/retrieval-pipeline.test.ts`: the deep fan fixture yields no expansion
      candidates; the existence-filter test covers seeds. `retrieval-pipeline.ts` comments
      follow.

## 3. Eval (needs 1; parallel-safe with 2)

- [x] 3.1 `eval/stats.ts` drops `expansion_neighbours` and `collectPopulations`' `expansionLimit`
      argument; `eval/run.ts` stops passing it; `eval/pipelines.ts` comments follow (D4). Tests:
      `test/eval/stats.test.ts` (no population; `seed_all` and the `expansionFloor` pass rate
      intact), `test/eval/pipelines.test.ts` (deep config `expansion: false, expansion_limit: 0`;
      the fused fan fixture has no expansion candidates; the seed read is the only `nearest`
      read), `test/eval/run.test.ts` (comment).

## 4. Docs (needs 1–3)

- [x] 4.1 Sweep (D5): `docs/guide/finding-notes.md`, `docs/guide/embedding-models.md`,
      `docs/guide/configuration.md`, `docs/architecture/retrieval-policy.md`,
      `docs/architecture/rank-fusion.md`, `docs/architecture/mcp-parameter-dictionary.md`,
      `docs/architecture/README.md`, `GLOSSARY.md`, `README.md`, `eval/README.md`. Afterwards
      grep `expansion`, `expansionFloor`, `EXPANSION_WEIGHT`, `expansion_similarity` and
      `related` over all of `docs/`, `README.md`, `GLOSSARY.md`, `eval/` and `src/` and read
      every remaining line.

## 5. Measure, verify, archive (sequential, last)

- [x] 5.1 Gates: `npm test`, `npm run lint`, `npm run typecheck`, `npm run format`,
      `npm run build`, `npx commitlint --from origin/main --to HEAD`.
- [x] 5.2 After-eval on the owner's vault, production fused deep, against the baseline in design
      §Context: `diagnostics.*.expansion` 0; hit@3 and MRR within ±0.02; R@10 down by at most
      about 0.02; fewer notes on controls. Aggregates in verify.md and the PR.
- [x] 5.3 One fresh whole-branch review subagent; verify → retrospective →
      `openspec archive expansion-off-by-default` → PR with `Closes #270`.
