# Verification Report

**Change**: `expansion-off-by-default`
**Verified at**: `2026-11-01 21:20`
**Verifier**: Claude Fable 5.1, the session that wrote the change, running as a side session of the
semantic-search research hand-over. It ran the gates, the evals and the scenario mapping itself.
A fresh review subagent read the whole branch and found one Critical, two Important, four Minor and
three Nit issues; every one but two Minors is fixed (§4).

Scope: branch `claude/expansion-off-by-default-b8b442`, one PR, `Closes #270`.

### Gates

| Gate                                          | Result                                                    |
| --------------------------------------------- | --------------------------------------------------------- |
| `npm test`                                    | 3274 passed, 4 skipped (base after the merge of main: 3256) |
| `npm run lint` (`eslint .`)                   | clean                                                     |
| `npm run typecheck` (`tsc --noEmit`)          | clean                                                     |
| `npm run format`                              | clean                                                     |
| `npm run build`                               | success                                                   |
| `npx commitlint --from origin/main --to HEAD` | clean (one `footer-leading-blank` warning on the first commit) |

### Eval (production, fused, deep, `harrier-270m`, owner's vault)

The golden set has 80 entries: 63 answerable and 17 controls. Reports stay in the vault's private
repository; only aggregates are quoted. The vault auto-commits, so the first "before" run
(`main` at 1450c51, taken when the change was opened) and the "after" run sit on different vault
states; the paired row re-ran `main`'s code from a scratch copy on the vault state of the "after"
run, minutes apart, and is the read that counts.

| run                              | hit@3 | MRR   | R@10  | controls returning anything | mean notes on controls | expansion-sourced notes (answerable / control) |
| -------------------------------- | ----- | ----- | ----- | --------------------------- | ---------------------- | ---------------------------------------------- |
| before, `main`, vault state A    | 0.905 | 0.817 | 0.830 | 3 of 17                     | 1.53                   | 128 / 8                                        |
| before, `main` code, vault state B (paired) | 0.905 | 0.797 | 0.804 | 3 of 17          | 1.53                   | 121 / 8                                        |
| after, branch, vault state B     | 0.921 | 0.834 | 0.801 | 3 of 17                     | 1.06                   | 0 / 0                                          |

Paired deltas (vault state B): hit@3 +0.016, MRR +0.037, R@10 −0.003, mean notes on controls
1.53 → 1.06, notes per answerable entry 10.4 → 9.2. Per entry, 6 answerable entries lose some
recall@10 and 6 gain some; 1 loses its hit@3 and 2 gain one; no entry's first relevant rank moves
on the losing side. The unpaired read (0.830 → 0.801) overstates the recall cost by the vault's
own drift (0.830 → 0.804 at unchanged code).

- **Guard: `diagnostics.*.expansion` 0 after.** Met.
- **Guard: hit@3 and MRR within ±0.02.** Met upward: both rise.
- **Guard: R@10 down by at most about 0.02.** Met on the paired read (−0.003). The research
  session predicted −0.016 [−0.04; 0.00].
- **Guard: fewer notes on controls.** Met (1.53 → 1.06); the same 3 of 17 controls still return
  something, now fewer notes each.

## 1. Structural Validation

`npx openspec validate --all --json`: every item valid after the delta specs were re-derived against
`main` (which moved by #269 and #272 while this change was open; see §4, Critical).

## 2. Task Completion

Tasks 1.1–5.2 are ticked. 5.3 (review → verify → retrospective → archive → PR) is this close-out.

## 3. Delta Spec Sync State

| Capability                   | Sync state   | Note                                                                                                  |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `hybrid-search`              | ✗ needs sync | REMOVED four requirements, ADDED three (two-source matches list, two-source fusion, inert `expansion_floor`), MODIFIED four |
| `retrieval-eval`             | ✗ needs sync | MODIFIED the pipeline axis, the model axis and the calibration statistics                              |
| `embedding-model-profiles`   | ✗ needs sync | MODIFIED "Similarity defaults belong to the profile"                                                   |
| `corpus-staleness-filtering` | ✗ needs sync | REMOVED and re-ADDED the existence requirement without the expansion-target scenario                   |
| `shared-corpus-reads`        | ✗ needs sync | MODIFIED the composed semantic leg                                                                     |

`openspec archive` applies them.

## 4. Review

One fresh whole-branch reviewer over `origin/main...HEAD`.

- **Critical — stale base.** `main` had gained #269 (lexical variant RRF) and #272 (lexical cut
  note) since the branch was cut; the delta's arity-invariance and matches-list requirements
  restated the old `query_stats` contract. Fixed: merged `origin/main` (three conflicts in
  `search-notes.ts`, the dictionary and the guide, resolved keeping both intents), re-derived
  the two requirements from the current spec, re-ran every gate.
- **Important — `retrieval-policy.md` claimed the description interpolates `expansionFloor`.**
  Fixed: the sentence now says the default is profile data read on explicit input and by
  `--stats`, and that the parameter's description quotes no value.
- **Important — the lexical/quick inert test asserted success only.** Fixed: both calls are
  compared `toEqual` with the same call without the parameter.
- **Minor — `configuration.md` still presented `expansion_floor` as meaningful.** Fixed.
- **Minor — the "no population" scenario was tested at `collectPopulations` only.** Fixed: the
  `--stats` run test pins the report's population keys and the `expansionFloor` pass rate.
- **Minor — dead `rawExpansion` existence-filter path in `retrieval-pipeline.ts`.** Kept on
  purpose: design D3 keeps the third source as always-empty data below the tool, so the pipeline
  stays unchanged; it goes with the mechanism at the next major (retrospective, follow-ups).
- **Minor — no test fills a deep call past 12 entries for the "effort controls volume" scenario.**
  Left as is: the merged-cap behaviour is pinned by the existing cap tests, and this change does
  not touch it; the scenario's new clause (no `"expansion"` provenance) is tested.
- **Nits — `EXPANSION_WEIGHT` and `expansion_weight` comments.** Fixed.

## 5. Scenario Coverage

Every delta scenario maps to a test:

| Scenario (delta)                                              | Test                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| effort controls volume: no `"expansion"` at deep              | `search-notes.test.ts` deep single/multi-query                        |
| neighbour of a seed does not enter the list                   | `search-notes.test.ts`, `search-notes-hybrid.test.ts` arity           |
| two-source fusion, reproducible order, path ties              | `rank-fusion.test.ts`, `retrieval-pipeline.test.ts`                   |
| `expansion_floor` advertised, coerced, bounded, described     | `search-notes-hybrid.test.ts` SDK gate, `search-notes-description.test.ts` |
| `expansion_floor` changes nothing at deep / quick / lexical    | `search-notes-hybrid.test.ts` inert describe                          |
| `threshold` never affects the lexical leg                     | existing hybrid tests                                                 |
| arity: same matches, same `query_stats`                       | `search-notes-hybrid.test.ts` arity describe                          |
| eval: `expansion: false`, `expansion_limit: 0`, floor recorded | `pipelines.test.ts`, `run.test.ts`                                   |
| eval: no `expansion_neighbours`, `seed_all` kept              | `stats.test.ts`, `run.test.ts`                                        |
| profile: no numeric default on `expansion_floor`              | `search-notes-description.test.ts`                                    |
| staleness: seeds filtered                                     | `retrieval-pipeline.test.ts`                                          |
| composed leg: one `nearest` read; explicit expansion parity   | `retrieval-parity.test.ts`                                            |

## Verdict

PASS. The contract, the code, the docs and the specs agree; the measured effect on the owner's
vault matches the research: fewer notes, higher precision, hit@3 and MRR up, recall held.
