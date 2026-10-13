# Verification Report

**Change**: `embedding-model-profiles`
**Verified at**: `2026-10-13 20:40`
**Verifier**: Claude Opus 5.5 (`/opsx:apply` PR 4 session; requirement mapping by a Sonnet subagent, checked by the controller)

Scope: the whole change. PRs 1–3 are merged (#135, #140, #141); PR 4 is this branch, `feat/embedding-model-profiles-pr4`, `2ffd2ee..163eb3e`.

---

## 0. Gates

| gate | result |
| --- | --- |
| `npm test` | ✅ 119 files passed, 1 skipped; **1553 passed / 4 skipped**. PR 3 on `main` (`2ffd2ee`): 1541 passed / 5 skipped. +12 tests; one fewer skipped because the CI-only tokenizer test lost its `bge-micro-v2` row. |
| `npm run lint` | ✅ clean (`eslint .`) |
| `npm run typecheck` | ✅ clean (`tsc --noEmit`) |
| `npm run build` | ✅ |

---

## 1. Structural Validation (`openspec validate --all`)

- [x] Every item is `"valid": true`

**Result**:

```text
✓ change/embedding-model-profiles
… (19 items total)
Totals: 19 passed, 0 failed (19 items)
```

| Item | Type | Issues |
|---|---|---|
| — | — | — |

---

## 2. Task Completion (`tasks.md`)

- [ ] Every `- [ ]` is now `- [x]`. 41 of 45 are checked. The four open ones are the delivery steps, which run after this report.

| Task | Why it is open | Blocks archive? |
|---|---|---|
| 14.1 verify | This report. It is checked when the report is committed | No |
| 14.2 retrospective | Next, after verify (schema order) | No. It precedes archive by design |
| 14.3 archive | Runs after the retrospective | — |
| 14.4 PR | Runs after archive | No |

The note against 12.2 (acceptance) is under § Warnings W1. The task is done: the runs were made and recorded. One of its bars was missed.

---

## 3. Delta Spec Sync State

| Capability | Sync state | Notes |
|---|---|---|
| `embedding-model-profiles` | ✗ needs sync (new capability) | `openspec/specs/embedding-model-profiles/` does not exist yet; archive creates it |
| `cli-index-command` | ✗ needs sync | 2 delta sections |
| `cli-startup-flags` | ✗ needs sync | |
| `embed-text-extraction` | ✗ needs sync | |
| `hybrid-search` | ✗ needs sync | |
| `own-corpus-index` | ✗ needs sync | |
| `retrieval-eval` | ✗ needs sync | 2 delta sections; "Calibration statistics" was amended in PR 4 (unranked populations) |
| `semantic-backend-lifecycle` | ✗ needs sync | |

These are expected to be unsynced before archive. `npx openspec archive embedding-model-profiles -y` syncs all eight (Task 14.3).

---

## 4. Requirements → implementation, scenarios → evidence

**Requirements: 29 / 29 implemented.** 28 match their intent. One partially matches (W4).

| Capability | Requirements | Status |
|---|---|---|
| `embedding-model-profiles` | Closed registry of verified profiles; One profile serves the whole process; Queries and documents embedded through separate calls; Truncation preserves the special-token template; Padding and pooling follow tokenizer and profile; Each profile's tokenizer template verified in CI; Similarity defaults belong to the profile | 6 yes, 1 partial ("separate calls": no check that a vector's length equals `profile.dims`, W4) |
| `cli-index-command` | Index reconciles on demand; `--model` matches server semantics; Corpus rebuild announced before it runs | 3 yes |
| `cli-startup-flags` | Model flag selects one profile from a closed set | yes |
| `embed-text-extraction` | Two fixed formulas (note text uncut); Content rules, not membership rules; Model input bounded to the context window | 3 yes |
| `own-corpus-index` | Manifest records identity and gates a rebuild (v2); Progress and per-note failure containment | 2 yes |
| `semantic-backend-lifecycle` | Startup serves what it can, never blocks; One model serves the process, queries first | 2 yes |
| `hybrid-search` | `expansion_floor` bounds the expansion leg; Expansion is a flattened third source; `threshold` hard filter, default-only fallback; `query_stats`; backfilled block evidence; arity invariance | 6 yes |
| `retrieval-eval` | Comparable JSON reports; Pipeline axis; Corpus loading (manifest gate); Model axis; Calibration statistics (unranked populations, baseline population refusal) | 5 yes |

**Scenarios: 95.**

| Evidence kind | Count | Notes |
|---|---|---|
| Unit or source test | 90 | Tools are reached through `registerTool` + `test/_gate.ts` |
| CI tokenizer job only | 1 | `test/integration/profile-tokenizers.test.ts` (`NEURO_VAULT_HF_TESTS=1`): the real template, padding side and truncation to exactly `max_tokens` for every profile |
| Real-vault data | 2 | `calibration.md` § Acceptance: default-profile acceptance run; `--model granite-97m` end to end through the stdio server |
| **Uncovered** | **2** | "Two vaults share the selected profile" (W2); "An incompatible corpus is rebuilt, not served" (only the stderr announcement is asserted, W3) |

### Acceptance (Task 12.2, from `calibration.md` § Acceptance)

| check | bar | measured | |
|---|---|---|---|
| default-profile cold index | minutes | 7.9 min, max RSS 1.58 GB, `failed=0`, manifest v2 written | ✅ |
| semantic UA MRR | ≥ 0.600 | 0.694 (bge-micro-v2: 0.321) | ✅ |
| semantic EN MRR | ≥ 0.800 | **0.786** (n = 4) | ❌ W1 |
| fused MRR | recorded | 0.792 overall / 0.752 UA / 1.000 EN | ✅ |
| `--model granite-97m` end to end | works through the server | rebuild announced, index `failed=0`, `search_notes` returns semantic hits, stdout pure JSON-RPC | ✅ |

Calibration (Task 12.1): all three profiles pass both guards at their chosen values: `deep_filtered_first_relevant` = 0 and `quick_hit_at_3_drop` = 0. No adjustment was needed. Values: `calibration.md` § Chosen values. They are pinned by `test/semantic/model-profiles.test.ts`.

---

## 5. Design / Specs Coherence Spot Check

| Item checked | Design says | Specs / code | Gap |
|---|---|---|---|
| D2 registry | 3 profiles, pinned revisions, no repo ids from input | `model-profiles.ts`, `config.ts` `choices` | none |
| D5 tokenisation | Query prefix encoded separately, never truncated (steps 2/4) | `tokenization.ts:62-63` encodes `prefix + content` together and then cuts to the budget; the comment explains why (boundary tokenisation) | wording drift (S1): equivalent while the prefix is shorter than the budget (harrier's is ~22 of 510 tokens), but not guarded |
| D6 batching | Per note, bucketed by length; queries interleave | `reconcile.ts` one call per note; `embed-queue.ts` `bucketByLength`, query lane first | none (D6 and the comment rewritten for the uncut note text in PR 4) |
| D8 manifest v2 | 10 identity fields; legacy named then rebuilt | `types.ts`, `shard-store.ts:328-374`, `corpus-backend.ts:174-179`, `cli-index.ts:89-93` | none |
| D10 thresholds | Profile data; descriptions interpolate the active values | `retrieval-policy.ts`, `search-notes.ts:522,530` | none. The one-model scale claim in the `expansion_floor` description was removed in PR 4 (`d9ee439`) |
| D11 calibration | Unranked populations; the owner's ruling for fallback/expansionFloor | `eval/stats.ts`, `calibration.md`, `model-profiles.ts` | none. The final review recomputed every value |
| D15 runtime | XDG cache dir, log level, Node ≥ 20.9 | `local-model-loader.ts`, `package.json` | none |

**Drift warnings** (non-blocking): S1 above.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree (`git status` clean at `163eb3e`)
- [ ] All related commits pushed. The push happens at Task 14.4.

**Commit range**: `2ffd2ee..163eb3e` (23 commits on PR 4).

---

## 7. Front-Door Routing Leak Detector (warning, non-blocking)

```bash
ls docs/superpowers/specs/*.md 2>/dev/null
```

- [x] No files

---

## 8. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` has no `[~]` rows, so this section is empty by rule. The real-vault checks this change needs (calibration and acceptance) ran in this cycle on a copy of the owner's vault. They are recorded in `calibration.md` and are not deferred.

---

## Warnings

- **W1 — the EN acceptance bar was missed.** harrier-270m's semantic EN MRR is 0.786 against D13's ≥ 0.8. With n = 4 that is one query: its relevant note ranks 7th here and 4th in the bake-off. Diagnosis (`calibration.md` § harrier-270m): stored vectors equal fresh single embeds (cosine 1.000000), UA reproduces the bake-off, and the six notes above it are topically close (0.416–0.453 vs 0.415). This is a near-tie, not a code defect. **Submitted for the owner's ruling at PR review**; ADR-0017 and `calibration.md` say the same.
- **W2 — no test that one selected profile serves two vaults.** `server.ts:124-126` wires one `EmbeddingService` from `config.semantic.model`, but `test/server-modules.test.ts` always injects its own factories. Follow-up: start the server with `--model granite-97m` and two vaults, and assert that one provider with identity `granite-97m`/384 reaches both backends.
- **W3 — no assertion that an incompatible corpus is never served.** `corpus-backend.ts:270-282` returns no snapshot for an incompatible manifest, so the vault stays `indexing`. The test checks only the stderr warning. Follow-up: assert `status() === 'indexing'` and no search results until the rebuild completes.
- **W4 — vector width is not checked against `profile.dims`.** The spec requires that every returned vector has the profile's dimension. `embedding-service.ts:73-86` takes the width from the model output. The corpus store's write guard catches a wrong-width document vector; a query vector is not checked. A mis-pinned `dims` would make query cosines meaningless without any error. Follow-up: throw in `embedRows` when `vector.length !== profile.dims`, naming the profile, with a unit test using a fake model of the wrong width.

W2–W4 concern code merged in PRs 1–2. None of them changes behaviour today, because every registered profile's real output width equals its `dims` (the CI tokenizer job and three cold indexes ran without a store refusal). They are filed as one follow-up task.

## Suggestions

- **S1** (D5 wording vs `encodeRow`): either throw when the encoded prefix alone would reach the budget, or rewrite D5 to describe joint encoding.
- Deferred minors from the per-task and final reviews were triaged by the final whole-branch review: every remaining one "can ship". Two became follow-up tasks: the `eval --stats` memory ceiling, and naming the differing field in rebuild messages. A third follow-up carries `--model` in the `SEMANTIC_INDEX_NOT_FOUND` hint.

---

## Overall Decision

- [ ] ✅ PASS — ready for finishing-a-development-branch and archive
- [x] ⚠️ PASS WITH WARNINGS — ready for the next steps, with these noted: W1 needs the owner's ruling at PR review; W2–W4 are coverage and defensive-check gaps in earlier PRs' code, filed as follow-ups
- [ ] ❌ FAIL — return to the failing artifact, fix it, and re-run verify

**Next step**: `retrospective.md` (14.2) → `npx openspec archive embedding-model-profiles -y` (14.3) → push and open PR 4 (14.4), then stop for review.
