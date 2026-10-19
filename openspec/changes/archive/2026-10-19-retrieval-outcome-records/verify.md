# Verification Report

> Produced by `/opsx:verify` after the apply phase, to confirm the implementation matches specs, design and
> tasks. Test paths are relative to `test/`; source paths are relative to the repository root. Test evidence is
> `file:line "test name"` (names shortened).

**Change**: `retrieval-outcome-records`
**Verified at**: `2026-10-19 19:07`
**Verifier**: Claude Opus 5.5 (the tail-PR session). It ran the gates, the eval and the scenario mapping itself. A read-only reviewer agent read the tail diff before the PR (section 4.4).

Scope: the whole change, which shipped as three PRs. #197 (preparatory, ADR-0015 pass-throughs) and #199 (outcome records, `deriveObservability`, `search_notes` on one return) are merged to `main`. This report covers the tail PR on branch `refactor/eval-through-pipeline`: `2e9f771` (eval through the pipeline) and `5cf862b` (docs). The branch was first cut from `189c8cc` (#199) and then rebased onto `ce9b9c0` (#198, the corpus seam, which merged in the meantime and rewrote `test/_memory-corpus.ts`, which these tests use). Gates and eval were re-run after the rebase.

## Summary

| Dimension    | Result |
| ------------ | ------ |
| Completeness | 13 of 14 tasks done. Open: 5.2 (this report, the retrospective, archive, PR), in progress. 2 requirements and 6 scenarios in 2 delta specs, all implemented. |
| Correctness  | 6 scenarios: 6 Covered (test), 0 uncovered. |
| Coherence    | 7 design decisions: 6 followed, 1 followed with a recorded addition (D7: eval fails on a failed semantic leg). 0 unrecorded deviations. |

---

## 0. Gates

At `f27c9d7` (rebased onto `ce9b9c0`, review fixes included):

| gate | result |
| --- | --- |
| `npm test` | pass: 170 files passed, 1 skipped; **2586 tests passed / 4 skipped**. Against its base this PR is net +3: the pin test is deleted (−1), and one pipeline test and three eval tests are added (+4). |
| `npm run lint` | clean (exit 0) |
| `npm run typecheck` | clean (exit 0) |
| `npm run format` | clean (exit 0) |
| `npm run build` | pass (exit 0) |
| `npx commitlint --from origin/main --to HEAD` | pass (exit 0) |
| `npx openspec validate --all --strict` | 26 passed, 0 failed |

### Eval (`npm run eval`, offline retrieval quality)

Owner's vault at `vault_sha 7c78b75`, `harrier-270m`, golden set n=25 (ua 21, en 4). Before is `641d134` (#197's commit: eval still re-assembles fusion from `executeRetrieval` + `fuseRanks`, and `eval/pipelines.ts` is byte-identical to `main` before this PR). After was run twice, both times with `rankFused` calling `runRetrievalPipeline`: at `f618a65` before the rebase, and again at the rebased head (`code_sha b3149c5`, the `5cf862b` code plus this report), because #198 changed the corpus code that eval loads in-process. Both after-runs give the results below. The review fixes after them (`1da1184`, `f27c9d7`) touch only tests, docs and one comment in `eval/pipelines.ts`, so the eval was not re-run for them. The vault working tree was clean for every run.

| pipeline | slice | before p@3 / mrr / hit@3 | after |
| --- | --- | --- | --- |
| semantic | overall | 0.373 / 0.709 / 0.800 | same |
| semantic | ua | 0.365 / 0.694 / 0.810 | same |
| semantic | en | 0.417 / 0.786 / 0.750 | same |
| fused | overall | 0.440 / 0.792 / 0.920 | same |
| fused | ua | 0.429 / 0.752 / 0.905 | same |
| fused | en | 0.500 / 1.000 / 1.000 | same |

Delta: 0 on every metric. The per-query fields were also diffed as JSON for both pipelines, with `code_sha` set aside. For all 25 queries, `top`, `top_scores`, `relevant_ranks`, `first_relevant_rank`, `reciprocal_rank`, `precision_at_3`, `hit_at_3` and `best_relevant_similarity` are identical, and so is `config`. With `config` identical, `evalConfig` now reads `EFFORT_PROFILES.deep` and `LEXICAL_PER_NOTE_CAP` but records the same numbers as the old literals.

Why nothing moved: the pipeline adds three steps the old re-assembly did not have, and none of them changes this run.

- **Existence filter**: eval passes an admit-all `filterExisting`, so seeds and expansion targets survive unchanged.
- **Merged cap**: the pipeline slices to `cap = EVAL_TOP_K = 10`, the same slice the old code made.
- **Pool numbers**: the pipeline does not forward `limit` or `expansionLimit`, so `executeRetrieval` takes them from `MODE_DEFAULTS.deep`, which is built from `EFFORT_PROFILES.deep`: 8 and 3, the values the old code passed explicitly.

The lexical leg gets `noteCap` 10 and `perNoteCap` 3 as before, with no `allowed` set. Expansion is recomputed from the semantic seeds after the admit-all filter, so it is the same list.

---

## 1. Structural Validation (`npx openspec validate --all --json`)

- [x] Every item is `"valid": true`

**Result**:

```text
totals: items 26, passed 26, failed 0
byType: change 2/2 passed, spec 24/24 passed (after the rebase as well)
```

The second change is `vault-client`, another session's change in flight; it is not touched here.

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every `- [ ]` is now `- [x]`. 13 of 14 are checked.

| Task | Why it is open | Blocks archive? |
|---|---|---|
| 5.2 verify.md, retrospective.md, archive, PR | In progress: this report, then the retrospective, `openspec archive`, and the PR | No |

---

## 3. Delta Spec Sync State

Two delta specs; the main specs are not synced yet. Archive does the sync.

| Capability | Sync state | Notes |
|---|---|---|
| `hybrid-search` | ✗ needs sync | ADDED, 1 requirement ("Observability fields derive from leg outcomes", 3 scenarios) |
| `retrieval-eval` | ✗ needs sync | MODIFIED, 1 requirement ("Standalone library execution", 3 scenarios) |

---

## 4. Design / Specs Coherence Spot Check

### 4.1 Requirements and scenarios

#### hybrid-search (1 requirement, 3 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Observability fields derive from leg outcomes | a semantic leg that fails mid-request reports null semantic counts | Covered (test) | `src/modules/semantic/retrieval-pipeline.ts` (`catch` records `{ status: 'failed', error }`); `src/modules/semantic/search-observability.ts` (`queryStatsEntry`: `semantic: null` unless `ran`; `semantic_status` `unavailable` unless the error is a `CorpusNotReadyError`); `semantic/search-observability.test.ts:154 "reports a failed semantic leg as one that did not run, with no fallback flag"`, `:112 "reports any other semantic failure as unavailable"`; through the tool, `semantic/tools/search-notes.test.ts:247 "reports a failed semantic leg as one that did not run in query_stats"` |
| | a filter matching no notes reads neither leg | Covered (test) | `retrieval-pipeline.ts` (empty `allowed` returns both records `skipped` before any read); `semantic/retrieval-pipeline.test.ts:188 "reads neither leg over an empty allowed set"`; `semantic/search-observability.test.ts:285 "is false when neither leg ran"`, `:168 "diagnoses nothing when neither leg ran"`; through the tool, `semantic/tools/search-notes-filter.test.ts:90`, `:113 "returns truncated: false for multi-query with empty allowed set"`, `semantic/tools/search-notes.test.ts:1243 "reports the state when the filter matches no notes"`, `semantic/tools/search-notes-hybrid.test.ts:521` |
| | any stage that dropped candidates sets truncated | Covered (test) | `search-observability.ts` (`truncated` = merged cut OR either leg's pool cut); `semantic/search-observability.test.ts:269 "is false when no stage dropped a candidate"`, `:275 "is true when any one stage dropped a candidate"` (each source alone); pipeline side, `semantic/retrieval-pipeline.test.ts:147 "cap slices the fused list and reports merged-cap truncation"`, `:154 "records a leg pool overflow on that leg, not as a merged-cap cut"`, `:174 "records the semantic pool cut on its own record"` |

#### retrieval-eval (1 requirement, 3 scenarios)

| Requirement | Scenario | Status | Evidence |
| --- | --- | --- | --- |
| Standalone library execution | No server required | Covered (test), also by hand | `eval/run.ts` imports the modules; `eval/run.test.ts` runs the runner in-process. By hand: both eval runs above, with no MCP server involved. |
| | Fused ordering reuses production fusion | Covered (test) | `eval/pipelines.ts` `rankFused` calls `runRetrievalPipeline`; `eval/pipelines.test.ts:119 "ranks exactly as runRetrievalPipeline at deep effort, threshold 0, cap top-k"` (on the retired pin's fixture: 8 seeds, 2 expansion-only notes, a lexical-only note, top-k as the cut; changing `rankFused`'s cap to 12 or its effort to `quick` fails it); `semantic/retrieval-pipeline.test.ts:97 "carries each candidate's fuseRanks score, best first"` (the score eval reports is fusion's score) |
| | A retuned effort profile reaches eval | Covered (test) | `eval/pipelines.ts` `evalConfig` reads `EFFORT_PROFILES.deep` / `LEXICAL_PER_NOTE_CAP`, and the pipeline reads the same file; `eval/pipelines.test.ts:158 "runs the legs with the knobs its config records"` (spies on the lexical reader and the corpus: `noteCap` / `perNoteCap`, the seed read's `limit` = pool + 1, the expansion read's floor and limit all equal `config`) |

### 4.2 Design decisions

| Decision | Status | Note |
|---|---|---|
| D1 Outcome records | Followed (#199) | `SemanticLegOutcome` / `LexicalLegOutcome` in `retrieval-pipeline.ts` |
| D2 A lexical failure still throws | Followed (#199) | No `failed` lexical variant |
| D3 The empty-filter case is a pipeline outcome | Followed (#199) | Short-circuit inside `runRetrievalPipeline` |
| D4 One pure deriver | Followed (#199) | `deriveObservability` |
| D5 Type ownership | Followed (#199) | `SemanticStatusField`, `QueryStatsEntry`, `DEGRADED_NOTES` in `search-observability.ts` |
| D6 Tests replace, not layer | Followed (#199) | Through-the-tool policy tests replaced by pure tests |
| D7 Eval invokes the pipeline | Followed, with one addition | Wired exactly as D7 states; the pin is deleted; `PipelineCandidate.score` added. **Addition:** `rankFused` throws when the semantic record is `failed`. The old `executeRetrieval` call threw on a failed leg, and the pipeline would instead degrade silently to lexical-only, so a broken corpus would have been reported as a `fused` run. Pinned by `eval/pipelines.test.ts:191 "fails instead of reporting a lexical-only run when the semantic leg throws"`. Also described in `eval/README.md`. |

**Drift warnings** (non-blocking): none. design.md's Open Question (whether "observability derives from leg outcome records" deserves an ADR) is still the owner's call; this change records the mechanism in `docs/architecture/retrieval-policy.md` §Leg outcome records and observability instead.

### 4.3 Constraints

- No tool-contract change: `search_notes`' input/output schemas are untouched in this PR. `PipelineCandidate.score` never reaches the payload, because `search_notes` maps candidates field by field (`src/modules/semantic/tools/search-notes.ts`, `matches` mapping).
- No number retuned: `effort-profiles.ts` changes only in its doc comment.
- Files owned by other sessions: none touched (`git diff --stat origin/main` lists only `eval/`, `src/modules/semantic/{retrieval-pipeline,effort-profiles}.ts`, `test/eval/`, `test/semantic/retrieval-pipeline.test.ts`, `docs/architecture/`, `eval/README.md`, `openspec/`).
- Docs sweep: `grep -rn "assembleUnified\|production-fusion-pin\|buildQueryStats\|queryStatsNote\|restates" docs eval/README.md src` matches only `src/modules/semantic/search-observability.ts`, where `queryStatsNote` / `toStatusField` are live functions. `docs/guide/` had no mention of any of them.

### 4.4 Review of the tail diff

A read-only reviewer agent read `ce9b9c0..5cf862b` before the PR. It found no Critical issues and confirmed that `rankFused` reproduces the old ordering knob for knob. Its findings and what was done:

| Severity | Finding | Resolution |
|---|---|---|
| Important | The new equivalence test ran on 3 vectors and 2 notes: no expansion leg and no cap reached, so a wrong effort or cap would pass. The `evalConfig` test compared `EFFORT_PROFILES` with itself. | Fixed in `1da1184`: the equivalence test runs on the retired pin's fan, a new test checks the knobs the run used against `config`, and the config test keeps only the fixed knobs. Mutation-checked (cap 12, effort `quick`). |
| Important | With the pin gone, nothing compares `search_notes` with `rankQuery('fused')` end to end. | Accepted, as design D7 decided: with one code path that comparison tests a function against itself. The two seams the pin crossed are covered elsewhere: the tool forwards `limit` as the pipeline's `cap` (`semantic/tools/search-notes-hybrid.test.ts:65 "caps the merged list via limit and reports truncated"`), and it builds `matches[]` from `candidates` with an order-preserving `.map` (`src/modules/semantic/tools/search-notes.ts`). |
| Minor | `retrieval-policy.md` table: an empty allowed set is also a semantic `skipped` | Fixed in `f27c9d7` |
| Minor | "the report's `config` cannot drift" overstates it: `k_policy` is still a literal | Narrowed to "the pool numbers" in `eval/README.md` and `eval/pipelines.ts` (`f27c9d7`, `1da1184`) |
| Minor | `rank-fusion.md`: `backlink_count` is attached by each tool, not only `search_notes` | Fixed in `f27c9d7` |
| Minor | `retrieval-policy.md:9`: the handler calls `runRetrievalPipeline`, not the policy | Fixed in `f27c9d7` |

---

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [ ] All related commits are pushed (pushed when the PR opens)

**Commit range**: `ce9b9c0..f27c9d7` (plus this report, the retrospective and the archive commit)

---

## 6. Front-Door Routing Leak Detector (warning, non-blocking)

`ls docs/superpowers/specs/*.md` finds nothing. No leak.

---

## 7. Deferred dogfood vs automated-test equivalence

plan.md has no `[~]` rows. The one manual check, the eval before/after, ran and is recorded in section 0.

---

## Overall Decision

**PASS.** No critical issues, no warnings. Ready for archive.
