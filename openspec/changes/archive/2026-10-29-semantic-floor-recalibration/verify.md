# Verification Report

**Change**: `semantic-floor-recalibration`
**Verified at**: `2026-10-29 23:55`
**Verifier**: Claude Opus 5.5, the session that wrote the change, running from a side session. It ran
the gates, the eval and the scenario mapping itself. A fresh review subagent read the whole diff
and found no Critical or Important issue and six Minor ones. Four are fixed in 1872712. Two are
kept on purpose (§4).

Scope: branch `claude/lucid-mayer-5135e1`, one PR, `Closes #230`.

### Gates

| Gate                                          | Result                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| `npm test`                                    | 2921 passed, 4 skipped (base 2912 passed; +9 tests) |
| `npm run lint` (`eslint .`)                   | clean                                                |
| `npm run typecheck` (`tsc --noEmit`)          | clean                                                |
| `npm run format`                              | clean                                                |
| `npm run build`                               | success                                              |
| `npx commitlint --from origin/main --to HEAD` | clean                                                |

### Eval (production, fused, `harrier-270m`, owner's vault)

The golden set has 80 entries: 63 answerable and 17 controls. Before is `main` (ea81059) and after
is 5b256ba. Both ran on the same vault commit; reports are in the vault's private repository.

| run          | hit@3 | MRR   | R@10  | controls returning anything | mean notes on controls |
| ------------ | ----- | ----- | ----- | --------------------------- | ---------------------- |
| quick before | 0.937 | 0.816 | 0.672 | 17 of 17                    | 3.53                   |
| quick after  | 0.937 | 0.836 | 0.676 | 6 of 17                     | 1.29                   |
| deep before  | 0.889 | 0.808 | 0.859 | 17 of 17                    | 12.0                   |
| deep after   | 0.905 | 0.819 | 0.824 | 6 of 17                     | 2.29                   |

- **Metric:** moved as simulated on #222. At both efforts, controls returning anything went from 17 to
  6, and the mean went to 1.29 (quick) and 2.29 (deep).
- **Quick guard:** holds. hit@3 is unchanged and R@10 rises. The one entry that loses its hit@3 is
  the English concept entry the decision accepted; another entry gains one.
- **Deep guard on hit@3:** holds (0.889 → 0.905).
- **Deep guard on R@10:** **not met.** The guard allows 0.859 less one entry (1/63), about 0.843. The
  run gives 0.824; the decision's simulation said 0.841. Three answerable entries lose deep
  recall:
  - the accepted English concept entry;
  - one Ukrainian concept entry whose relevant note scores 0.40, which ranked 4th before and was
    never a hit@3;
  - half of one name entry.
  One name entry gains a third of its recall.
- **Deep-floor sweep** (local, quick held at 0.45, nothing committed):

  | deep floor | R@10  | controls returning anything | mean |
  | ---------- | ----- | --------------------------- | ---- |
  | 0.40       | 0.843 | 12 of 17                    | 6.06 |
  | 0.42       | 0.819 | 9 of 17                     | 3.76 |
  | 0.43       | 0.819 | 8 of 17                     | 3.24 |
  | 0.44       | 0.819 | 8 of 17                     | 2.76 |
  | 0.45       | 0.824 | 6 of 17                     | 2.29 |

  Lowering the deep floor does not recover recall until 0.40, and 0.40 gives back half the noise
  win. Between 0.42 and 0.44 recall is lower than at 0.45: the extra weak seeds recruit expansion
  neighbours that push relevant notes out of the 12-note cap. 0.45 is kept, as decided. Whether
  the deep R@10 loss is acceptable is the owner's ruling at PR review. #232 (expansion as tail fill)
  is the epic's change aimed at deep recall.

## 1. Structural Validation

`npx openspec validate --all --json`: 27 of 27 items valid.

## 2. Task Completion

Tasks 1.1–5.1 and 6.2 are ticked. 6.1 (gates, above) and 6.3 (verify → retrospective → archive → PR)
are this close-out.

## 3. Delta Spec Sync State

| Capability                 | Sync state | Note                                                                             |
| -------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `embedding-model-profiles` | ✗ needs sync | MODIFIED "Similarity defaults belong to the profile"; `openspec archive` syncs it |
| `hybrid-search`            | ✗ needs sync | MODIFIED "threshold is a hard semantic filter…" and "Semantic seeds carry backfilled block evidence" |
| `retrieval-eval`           | ✗ needs sync | MODIFIED "Calibration statistics"                                                |

## 4. Design / Specs Coherence Spot Check

| Sample                   | design                                 | specs                                                         | gap  |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------- | ---- |
| D2 values                | quick 0.45, deep 0.45                  | embedding-model-profiles: harrier-270m 0.45 at both           | none |
| D3 optional fallback     | retry only when the profile has one    | hybrid-search: "provided the profile defines one" + scenario  | none |
| D4 block floor           | `blockFloor`, previous `deep` values   | embedding-model-profiles + hybrid-search block requirement    | none |
| D5 description           | no retry stated without a fallback     | embedding-model-profiles scenario "states no retry"           | none |
| D6 eval                  | measured defaults only; no block floor | retrieval-eval "Calibration statistics" + scenario            | none |

Reviewer Minors kept on purpose:

- "A profile without a fallback returns an honest zero" is pinned in two halves: the policy makes
  no retry read, and observability carries no `semantic_fallback`. No single `search_notes` gate
  test joins them. Both halves are pure, and the handler passes `similarity.fallback` straight
  through.
- The spec scenario where a raised note floor does not thin block evidence is pinned by the
  threshold the deep block read receives (`blockFloor`, not `deep`). No fixture filters blocks that
  score between the two. The corpus's block filter is the same code at any threshold.

Drift warnings: the design's guard expectation (the one accepted entry) did not hold for deep R@10
(see Eval above).

## 5. Implementation Signal

- [x] No unstaged files in the worktree
- [ ] All commits pushed (pushed with the PR)

Commit range: `ea81059..1872712`.

## 6. Front-Door Routing Leak Detector

`ls docs/superpowers/specs/*.md`: no files.

## 7. Deferred Manual Dogfood vs Automated Test Equivalence

`plan.md` has no `[~]` rows. The one manual check, the after-eval on the owner's vault, ran
(§Eval).

## Overall Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — the deep R@10 guard is not met (0.824 against about 0.843). It goes to
      the owner's ruling at PR review, together with the open ADR question in design.md.
- [ ] ❌ FAIL

**Next step:** retrospective → archive → PR, which flags the deep R@10 breach.
