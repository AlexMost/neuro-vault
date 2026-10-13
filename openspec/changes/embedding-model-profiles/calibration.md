# Calibration — embedding-model-profiles

Similarity defaults are calibrated per profile by design D11: each default is set to the threshold that reproduces its bge-micro-v2 pass rate on the new profile's own population, then checked against the two golden-set guards. This file holds the inputs and results. Aggregates only: no per-query rows, no note paths.

## Baseline — bge-micro-v2

Captured in PR 3 (Task 10.1), before any other profile indexed the vault. The capture ran on a copy of the owner's vault, over its existing bge-micro-v2 corpus (manifest `bge-micro-v2`, `embed_version 1`, 888 notes with a note vector). The golden set has 25 queries: 21 `ua`, 4 `en`.

```bash
npm run eval -- --vault <vault copy> --model bge-micro-v2 --pipeline semantic --stats
```

The full report holds per-query paths, so it lives outside git, in the main checkout's gitignored `eval/results/baseline-bge-micro-v2.json`. PR 4 passes that file to `--baseline`. Both SHAs are clean, so the report counts as comparable under the harness's rule.

### Retrieval quality

Overall MRR is 0.398, the same as PR 1, so moving the thresholds into the profile changed nothing semantic.

| slice   | n  | p@3   | MRR   | hit@3 |
| ------- | -- | ----- | ----- | ----- |
| overall | 25 | 0.240 | 0.398 | 0.400 |
| ua      | 21 | 0.206 | 0.321 | 0.333 |
| en      | 4  | 0.417 | 0.800 | 0.750 |

### Populations (quantiles)

| population             | n     | min   | p05   | p10   | p25   | p50   | p75   | p90   | p95   | max   |
| ---------------------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `query_candidates`     | 250   | 0.559 | 0.635 | 0.664 | 0.743 | 0.798 | 0.821 | 0.838 | 0.855 | 0.878 |
| `expansion_neighbours` | 600   | 0.766 | 0.831 | 0.855 | 0.885 | 0.905 | 0.925 | 0.951 | 0.959 | 0.993 |
| `note_top10`           | 8 880 | 0.685 | 0.803 | 0.823 | 0.855 | 0.887 | 0.921 | 0.955 | 0.985 | 0.999 |
| `note_max`             | 888   | 0.734 | 0.840 | 0.861 | 0.891 | 0.916 | 0.951 | 0.980 | 0.995 | 0.999 |

### Pass rates of today's defaults

| default          | population             | threshold | pass rate |
| ---------------- | ---------------------- | --------- | --------- |
| `quick`          | `query_candidates`     | 0.50      | 1.000     |
| `deep`           | `query_candidates`     | 0.35      | 1.000     |
| `fallback`       | `query_candidates`     | 0.30      | 1.000     |
| `expansionFloor` | `expansion_neighbours` | 0.35      | 1.000     |
| `similarNotes`   | `note_top10`           | 0.50      | 1.000     |
| `duplicates`     | `note_max`             | 0.90      | 0.675     |

### Guards at today's defaults

- `deep_filtered_first_relevant` = 0 (target 0).
- `quick_hit_at_3_drop` = 0 (target ≤ 1).

### Raw aggregates

```json
{
  "code_sha": "e52fe8327234ac3b4f07db596c67a56f90066c3c",
  "vault_sha": "98b836447954abb13915cc4cfa239179a0d2416f",
  "model_key": "bge-micro-v2",
  "identity": {
    "provider": "transformers.js",
    "model_key": "bge-micro-v2",
    "model_id": "TaylorAI/bge-micro-v2",
    "revision": "3edf6d7de0faa426b09780416fe61009f26ae589",
    "dtype": "q8",
    "dims": 384,
    "pooling": "mean",
    "max_tokens": 512
  },
  "config": {
    "top_k": 10,
    "semantic_threshold": 0,
    "semantic_pool": 8,
    "expansion_limit": 3,
    "expansion_floor": 0.35,
    "lexical_note_cap": 10,
    "lexical_per_note_cap": 3,
    "expansion_weight": 0.85,
    "k_policy": "round(sqrt(totalNotes)) clamped 5..60"
  },
  "metrics": {
    "overall": { "n": 25, "precision_at_3": 0.24, "mrr": 0.39799999999999996, "hit_at_3": 0.4 },
    "ua": { "n": 21, "precision_at_3": 0.20634920634920634, "mrr": 0.32142857142857145, "hit_at_3": 0.3333333333333333 },
    "en": { "n": 4, "precision_at_3": 0.41666666666666663, "mrr": 0.8, "hit_at_3": 0.75 }
  },
  "stats": {
    "populations": {
      "query_candidates": { "n": 250, "min": 0.558838722603341, "p05": 0.6353039518255856, "p10": 0.6640367171148182, "p25": 0.7433776108519242, "p50": 0.7979223047344187, "p75": 0.8213063429363009, "p90": 0.8382240751314861, "p95": 0.8549883593110302, "max": 0.878022769341645 },
      "expansion_neighbours": { "n": 600, "min": 0.7662285414373137, "p05": 0.8308032195055297, "p10": 0.8548569057873131, "p25": 0.8851065897954393, "p50": 0.9053151468699506, "p75": 0.9252331916370912, "p90": 0.9512324216085868, "p95": 0.9585419358794726, "max": 0.9928306389792437 },
      "note_top10": { "n": 8880, "min": 0.6847494500179815, "p05": 0.8027520477629199, "p10": 0.8233549512855788, "p25": 0.8547533419557873, "p50": 0.8874378568734028, "p75": 0.9208182517789848, "p90": 0.9552090757724966, "p95": 0.9854147817666774, "max": 0.9986376997885361 },
      "note_max": { "n": 888, "min": 0.733659023561025, "p05": 0.8398299949744025, "p10": 0.8607434904717507, "p25": 0.890930712952584, "p50": 0.9163755560612419, "p75": 0.9512233540617443, "p90": 0.9796635466541768, "p95": 0.9952186905146794, "max": 0.9986376997885361 }
    },
    "pass_rates": {
      "quick": { "population": "query_candidates", "threshold": 0.5, "pass_rate": 1 },
      "deep": { "population": "query_candidates", "threshold": 0.35, "pass_rate": 1 },
      "fallback": { "population": "query_candidates", "threshold": 0.3, "pass_rate": 1 },
      "expansionFloor": { "population": "expansion_neighbours", "threshold": 0.35, "pass_rate": 1 },
      "similarNotes": { "population": "note_top10", "threshold": 0.5, "pass_rate": 1 },
      "duplicates": { "population": "note_max", "threshold": 0.9, "pass_rate": 0.6745495495495496 }
    },
    "guards": { "deep_filtered_first_relevant": 0, "quick_hit_at_3_drop": 0 }
  }
}
```

## Reading the baseline — open question for PR 4

> **Decided in PR 4** (design D11): pass rates are measured on unranked populations: query↔every note for `quick`, `deep` and `fallback`, seed↔every note for `expansionFloor`, note↔every note for `similarNotes`, and `note_max` for `duplicates`. The baseline is re-captured on them (Task 11.0). The text below is the question as PR 3 left it.

**On bge-micro-v2, five of the six defaults filter nothing in the population they govern.** bge-micro's similarities are compressed into a narrow, high band. The lowest of the 250 top-10 query candidates scores 0.559, above `quick` (0.50). The lowest expansion neighbour scores 0.766, against an `expansionFloor` of 0.35. Only `duplicates` cuts anything: 67.5 % of notes have a neighbour at 0.90 or above.

D11's quantile matching therefore degenerates for those five. Reproducing a pass rate of 1.0 means "the population minimum on the new profile", so on any profile:

- `quick`, `deep` and `fallback` would all collapse to the same value. That breaks the `quick ≥ deep > fallback` ordering the registry test enforces, and it leaves the fallback retry with nothing to retry at.
- Each threshold would sit exactly at a sample minimum. That says nothing about where the new model's score for "unrelated" begins.

What the baseline does transfer: these defaults never cut a top-10 candidate (query side) or a top-10 neighbour (note side), and the guards pass at 0 / 0. PR 4 Task 12.1 has to decide how to keep that behaviour on a wider-spread scale. Options include: matching the bge pass rate of a deeper population (e.g. ranks beyond 10); anchoring on the bge threshold's position relative to the bge distribution instead of its pass rate; or keeping "filters nothing in the top 10" as the target and choosing values below the new population's minimum with the ordering preserved. Only `duplicates` can be matched as D11 describes. This is a design decision for review before PR 4, not something PR 3 settles.
