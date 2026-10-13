# Calibration — embedding-model-profiles

Similarity defaults are calibrated per profile by design D11: each default is set to the threshold that reproduces its bge-micro-v2 pass rate on the new profile's own population, then checked against the two golden-set guards. This file holds the inputs and results. Aggregates only: no per-query rows, no note paths.

## Baseline — bge-micro-v2

> **Superseded for calibration** by [Baseline — bge-micro-v2, unranked populations](#baseline--bge-micro-v2-unranked-populations). This section is kept as history: it is the ranked-population baseline whose degeneracy led to design D11's choice.

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

## Baseline — bge-micro-v2, unranked populations

Captured in PR 4 (Task 11.0), before Task 11.3 removed `bge-micro-v2` from the registry. Design D11 matches each default on an unranked population, and this is the baseline for that. It ran on a fresh copy of the owner's vault. The copy's bge-micro-v2 corpus (`embed_version 1`) was first reconciled with `index --model bge-micro-v2`: 949 notes, 0 re-embedded, no rebuild. 888 notes have a note vector. The vault state is the same commit as PR 3's capture (`vault_sha` `98b8364…`, clean), and the metrics reproduce exactly.

```bash
npx tsx ./eval/run.ts --vault <vault copy> --model bge-micro-v2 --pipeline semantic --stats
```

The full report lives outside git, in the main checkout's gitignored `eval/results/baseline-bge-micro-v2-unranked.json`. Task 12.1 passes it to `--baseline`.

### Retrieval quality

| slice   | n  | p@3   | MRR   | hit@3 |
| ------- | -- | ----- | ----- | ----- |
| overall | 25 | 0.240 | 0.398 | 0.400 |
| ua      | 21 | 0.206 | 0.321 | 0.333 |
| en      | 4  | 0.417 | 0.800 | 0.750 |

### Populations (quantiles)

| population             | kind     | n       | min   | p05   | p10   | p25   | p50   | p75   | p90   | p95   | max   |
| ---------------------- | -------- | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `query_candidates`     | ranked   | 250     | 0.559 | 0.635 | 0.664 | 0.743 | 0.798 | 0.821 | 0.838 | 0.855 | 0.878 |
| `expansion_neighbours` | ranked   | 600     | 0.766 | 0.831 | 0.855 | 0.885 | 0.905 | 0.925 | 0.951 | 0.959 | 0.993 |
| `note_top10`           | ranked   | 8 880   | 0.685 | 0.803 | 0.823 | 0.855 | 0.887 | 0.921 | 0.955 | 0.985 | 0.999 |
| `query_all`            | unranked | 22 200  | 0.337 | 0.475 | 0.512 | 0.626 | 0.681 | 0.724 | 0.755 | 0.772 | 0.878 |
| `seed_all`             | unranked | 176 000 | 0.471 | 0.659 | 0.685 | 0.726 | 0.766 | 0.799 | 0.828 | 0.848 | 0.993 |
| `note_all`             | unranked | 787 656 | 0.465 | 0.640 | 0.663 | 0.700 | 0.738 | 0.776 | 0.815 | 0.854 | 0.999 |
| `note_max`             | max      | 888     | 0.734 | 0.840 | 0.861 | 0.891 | 0.916 | 0.951 | 0.980 | 0.995 | 0.999 |

### Pass rates of the bge defaults

| default          | population  | threshold | pass rate | cut                |
| ---------------- | ----------- | --------- | --------- | ------------------ |
| `quick`          | `query_all` | 0.50      | 0.9177    | 1 828 of 22 200    |
| `deep`           | `query_all` | 0.35      | 0.9991    | 19 of 22 200       |
| `fallback`       | `query_all` | 0.30      | 1.0000    | none               |
| `expansionFloor` | `seed_all`  | 0.35      | 1.0000    | none               |
| `similarNotes`   | `note_all`  | 0.50      | 0.99974   | 208 of 787 656     |
| `duplicates`     | `note_max`  | 0.90      | 0.6745    | 289 of 888         |

Guards at these defaults: `deep_filtered_first_relevant` = 0 (target 0), `quick_hit_at_3_drop` = 0 (target ≤ 1).

### Reading it

D11's decision rule tripped. `fallback` and `expansionFloor` pass 1.0 even here. Both sit below every pair on the vault: 0.30 against a `query_all` minimum of 0.337, and 0.35 against a `seed_all` minimum of 0.471. On bge they cut nothing at all. The owner ruled (design D11, "Outcome of the rule"): on each profile, each is set just below the minimum of its own unranked population, rounded down to 0.05, keeping `fallback < deep`.

`quick` and `duplicates` sit well inside their distributions and match cleanly. `deep` and `similarNotes` pass less than 1.0 but come from the far tail (0.09 % and 0.03 % cut). They are matched as D11 step 2 says, but their suggested values rest on a few dozen and a few hundred extreme pairs respectively, so they are sensitive to those pairs.

### Raw aggregates

```json
{
  "code_sha": "8a70ec46a06168a660c058b66d4f29d11a85f7a0",
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
    "overall": {
      "n": 25,
      "precision_at_3": 0.24,
      "mrr": 0.39799999999999996,
      "hit_at_3": 0.4
    },
    "ua": {
      "n": 21,
      "precision_at_3": 0.20634920634920634,
      "mrr": 0.32142857142857145,
      "hit_at_3": 0.3333333333333333
    },
    "en": {
      "n": 4,
      "precision_at_3": 0.41666666666666663,
      "mrr": 0.8,
      "hit_at_3": 0.75
    }
  },
  "stats": {
    "populations": {
      "query_candidates": { "n": 250, "min": 0.558838722603341, "p05": 0.6353039518255856, "p10": 0.6640367171148182, "p25": 0.7433776108519242, "p50": 0.7979223047344187, "p75": 0.8213063429363009, "p90": 0.8382240751314861, "p95": 0.8549883593110302, "max": 0.878022769341645 },
      "expansion_neighbours": { "n": 600, "min": 0.7662285414373137, "p05": 0.8308032195055297, "p10": 0.8548569057873131, "p25": 0.8851065897954393, "p50": 0.9053151468699506, "p75": 0.9252331916370912, "p90": 0.9512324216085868, "p95": 0.9585419358794726, "max": 0.9928306389792437 },
      "note_top10": { "n": 8880, "min": 0.6847494500179815, "p05": 0.8027520477629199, "p10": 0.8233549512855788, "p25": 0.8547533419557873, "p50": 0.8874378568734028, "p75": 0.9208182517789848, "p90": 0.9552090757724966, "p95": 0.9854147817666774, "max": 0.9986376997885361 },
      "note_max": { "n": 888, "min": 0.733659023561025, "p05": 0.8398299949744025, "p10": 0.8607434904717507, "p25": 0.890930712952584, "p50": 0.9163755560612419, "p75": 0.9512233540617443, "p90": 0.9796635466541768, "p95": 0.9952186905146794, "max": 0.9986376997885361 },
      "query_all": { "n": 22200, "min": 0.3373590604341732, "p05": 0.47488587855998315, "p10": 0.5115163431391109, "p25": 0.6257858101250481, "p50": 0.6813787302189057, "p75": 0.7239331826330291, "p90": 0.7546138256126038, "p95": 0.7723772973305827, "max": 0.878022769341645 },
      "seed_all": { "n": 176000, "min": 0.4713849645093297, "p05": 0.6586371840603993, "p10": 0.6848709339384976, "p25": 0.7260863744499952, "p50": 0.7662907729834841, "p75": 0.7992066860977239, "p90": 0.8283248204073671, "p95": 0.8477623254040767, "max": 0.9928306389792437 },
      "note_all": { "n": 787656, "min": 0.4653488103192912, "p05": 0.6403686066296372, "p10": 0.6629164866373898, "p25": 0.7000253644661983, "p50": 0.7384234180059196, "p75": 0.7755526290608034, "p90": 0.814876676389674, "p95": 0.8537019052652149, "max": 0.9986376997885361 }
    },
    "pass_rates": {
      "quick": { "population": "query_all", "threshold": 0.5, "pass_rate": 0.9176576576576576 },
      "deep": { "population": "query_all", "threshold": 0.35, "pass_rate": 0.9991441441441441 },
      "fallback": { "population": "query_all", "threshold": 0.3, "pass_rate": 1 },
      "expansionFloor": { "population": "seed_all", "threshold": 0.35, "pass_rate": 1 },
      "similarNotes": { "population": "note_all", "threshold": 0.5, "pass_rate": 0.9997359253278081 },
      "duplicates": { "population": "note_max", "threshold": 0.9, "pass_rate": 0.6745495495495496 }
    },
    "guards": {
      "deep_filtered_first_relevant": 0,
      "quick_hit_at_3_drop": 0
    }
  }
}
```

# Per-profile calibration (PR 4, Task 12.1)

Each profile was cold-indexed on its own clone of the vault copy the unranked bge baseline was taken on (same `vault_sha` `98b8364…`, clean), then measured with `--stats --baseline baseline-bge-micro-v2-unranked.json`, then re-measured with the chosen values written into the profile (`--stats`, no re-index). Method: design D11 and its "Outcome of the rule". The reports' `code_sha` reads `-dirty` because the chosen values were in the working tree, not yet committed, while they were being verified. Index-time code was the committed HEAD.

## harrier-270m

Cold index of a corpus-less clone of the vault copy (same `vault_sha` as the baseline): **8.8 min** wall (525.7 s), max RSS **1.32 GB**, `failed=0`. Other CPU work (test runs, review agents) overlapped the run, so the time is upper-side.

### Retrieval quality (semantic)

| slice   | n  | p@3   | MRR   | hit@3 |
| ------- | -- | ----- | ----- | ----- |
| overall | 25 | 0.373 | 0.709 | 0.800 |
| ua      | 21 | 0.365 | 0.694 | 0.810 |
| en      | 4  | 0.417 | 0.786 | 0.750 |

### Populations (quantiles)

| population             | n       | min   | p05   | p10   | p25   | p50   | p75   | p90   | p95   | max   |
| ---------------------- | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `query_candidates`     | 250     | 0.322 | 0.337 | 0.361 | 0.407 | 0.460 | 0.522 | 0.591 | 0.620 | 0.747 |
| `expansion_neighbours` | 600     | 0.545 | 0.646 | 0.674 | 0.699 | 0.738 | 0.768 | 0.803 | 0.828 | 0.949 |
| `note_top10`           | 8 880   | 0.506 | 0.611 | 0.642 | 0.690 | 0.734 | 0.807 | 0.912 | 0.938 | 0.993 |
| `note_max`             | 888     | 0.558 | 0.689 | 0.716 | 0.761 | 0.808 | 0.885 | 0.946 | 0.965 | 0.993 |
| `query_all`            | 22 200  | 0.100 | 0.193 | 0.215 | 0.255 | 0.310 | 0.365 | 0.411 | 0.440 | 0.747 |
| `seed_all`             | 176 000 | 0.202 | 0.348 | 0.375 | 0.430 | 0.489 | 0.544 | 0.597 | 0.630 | 0.949 |
| `note_all`             | 787 656 | 0.194 | 0.335 | 0.365 | 0.422 | 0.485 | 0.546 | 0.613 | 0.675 | 0.993 |

### Defaults: baseline pass rate → suggested → chosen

| default          | population  | bge pass rate | suggested | chosen | pass rate at chosen | how chosen |
| ---------------- | ----------- | ------------- | --------- | ------ | ------------------- | ---------- |
| `quick`          | `query_all` | 0.9177 | 0.2088 | 0.20 | 0.9365 | suggested, rounded down to 2 decimals |
| `deep`           | `query_all` | 0.9991 | 0.1354 | 0.13 | 0.9995 | suggested, rounded down to 2 decimals |
| `fallback`       | `query_all` | 1.0000 | 0.0997 | 0.05 | 1.0000 | below the population minimum (0.0997), rounded down to 0.05 |
| `expansionFloor` | `seed_all` | 1.0000 | 0.2015 | 0.20 | 1.0000 | below the population minimum (0.2015), rounded down to 0.05 |
| `similarNotes`   | `note_all` | 0.9997 | 0.2242 | 0.22 | 0.9999 | suggested, rounded down to 2 decimals |
| `duplicates`     | `note_max` | 0.6745 | 0.7782 | 0.77 | 0.7140 | suggested, rounded down to 2 decimals |

Guards at the chosen values: `deep_filtered_first_relevant` = 0 (target 0), `quick_hit_at_3_drop` = 0 (target ≤ 1). No adjustment was needed.

**English slice below the acceptance bar.** EN MRR is 0.786, against the 0.8 bar, bge's 0.800 and the bake-off's 0.812 for the same model. With n = 4 that is one query: its relevant note ranks 7th here and 4th in the bake-off. A diagnosis ruled out a code cause. Every note in that query's top 10 has a stored vector identical to a fresh single embed (cosine 1.000000), so batching, padding and pooling don't distort it. UA, which exercises the same path, reproduces the bake-off (0.694 vs 0.695). The six notes ranked above it are topically close (similarities 0.416–0.453 against the relevant note's 0.415). So this is a near-tie on one query, not a regression. It is left for the owner to judge at review.

## granite-97m

Cold index of a corpus-less clone of the vault copy (same `vault_sha` as the baseline): **3.5 min** wall (210.7 s), max RSS **1.20 GB**, `failed=0`. Other CPU work (test runs, review agents) overlapped the run, so the time is upper-side.

### Retrieval quality (semantic)

| slice   | n  | p@3   | MRR   | hit@3 |
| ------- | -- | ----- | ----- | ----- |
| overall | 25 | 0.280 | 0.549 | 0.600 |
| ua      | 21 | 0.238 | 0.463 | 0.524 |
| en      | 4  | 0.500 | 1.000 | 1.000 |

### Populations (quantiles)

| population             | n       | min   | p05   | p10   | p25   | p50   | p75   | p90   | p95   | max   |
| ---------------------- | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `query_candidates`     | 250     | 0.769 | 0.779 | 0.786 | 0.796 | 0.811 | 0.847 | 0.866 | 0.881 | 0.924 |
| `expansion_neighbours` | 600     | 0.800 | 0.848 | 0.862 | 0.876 | 0.890 | 0.905 | 0.924 | 0.934 | 0.960 |
| `note_top10`           | 8 880   | 0.786 | 0.832 | 0.845 | 0.864 | 0.885 | 0.919 | 0.975 | 0.985 | 0.997 |
| `note_max`             | 888     | 0.817 | 0.864 | 0.875 | 0.897 | 0.919 | 0.954 | 0.986 | 0.993 | 0.997 |
| `query_all`            | 22 200  | 0.652 | 0.704 | 0.713 | 0.729 | 0.746 | 0.766 | 0.786 | 0.800 | 0.924 |
| `seed_all`             | 176 000 | 0.657 | 0.727 | 0.738 | 0.756 | 0.778 | 0.802 | 0.826 | 0.842 | 0.960 |
| `note_all`             | 787 656 | 0.649 | 0.727 | 0.737 | 0.755 | 0.776 | 0.800 | 0.830 | 0.858 | 0.997 |

### Defaults: baseline pass rate → suggested → chosen

| default          | population  | bge pass rate | suggested | chosen | pass rate at chosen | how chosen |
| ---------------- | ----------- | ------------- | --------- | ------ | ------------------- | ---------- |
| `quick`          | `query_all` | 0.9177 | 0.7106 | 0.71 | 0.9212 | suggested, rounded down to 2 decimals |
| `deep`           | `query_all` | 0.9991 | 0.6649 | 0.66 | 0.9997 | suggested, rounded down to 2 decimals |
| `fallback`       | `query_all` | 1.0000 | 0.6515 | 0.65 | 1.0000 | below the population minimum (0.6515), rounded down to 0.05 |
| `expansionFloor` | `seed_all` | 1.0000 | 0.6565 | 0.65 | 1.0000 | below the population minimum (0.6565), rounded down to 0.05 |
| `similarNotes`   | `note_all` | 0.9997 | 0.6738 | 0.67 | 0.9998 | suggested, rounded down to 2 decimals |
| `duplicates`     | `note_max` | 0.6745 | 0.9032 | 0.90 | 0.7038 | suggested, rounded down to 2 decimals |

Guards at the chosen values: `deep_filtered_first_relevant` = 0 (target 0), `quick_hit_at_3_drop` = 0 (target ≤ 1). No adjustment was needed.

granite-97m reproduces the bake-off's numbers exactly (UA 0.463, EN 1.000, overall 0.549). Its scale is narrow and high: every query↔note similarity lies in 0.652–0.924. So `fallback` (0.65) sits only 0.01 under `deep` (0.66). The ordering holds, but on this vault the fallback retry and the `deep` floor are nearly the same filter.

## harrier-0.6b

Cold index of a corpus-less clone of the vault copy (same `vault_sha` as the baseline): **35.5 min** wall (2127.6 s), max RSS **2.40 GB**, `failed=0`. Other CPU work (test runs, review agents) overlapped the run, so the time is upper-side.

### Retrieval quality (semantic)

| slice   | n  | p@3   | MRR   | hit@3 |
| ------- | -- | ----- | ----- | ----- |
| overall | 25 | 0.400 | 0.769 | 0.880 |
| ua      | 21 | 0.381 | 0.749 | 0.857 |
| en      | 4  | 0.500 | 0.875 | 1.000 |

### Populations (quantiles)

| population             | n       | min   | p05   | p10   | p25   | p50   | p75   | p90   | p95   | max   |
| ---------------------- | ------- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| `query_candidates`     | 250     | 0.343 | 0.371 | 0.395 | 0.423 | 0.475 | 0.538 | 0.609 | 0.624 | 0.722 |
| `expansion_neighbours` | 600     | 0.473 | 0.626 | 0.647 | 0.689 | 0.727 | 0.768 | 0.798 | 0.822 | 0.911 |
| `note_top10`           | 8 880   | 0.462 | 0.589 | 0.620 | 0.666 | 0.714 | 0.796 | 0.891 | 0.926 | 0.989 |
| `note_max`             | 888     | 0.520 | 0.659 | 0.696 | 0.749 | 0.795 | 0.880 | 0.939 | 0.960 | 0.989 |
| `query_all`            | 22 200  | 0.171 | 0.248 | 0.263 | 0.289 | 0.327 | 0.371 | 0.413 | 0.438 | 0.722 |
| `seed_all`             | 176 000 | 0.269 | 0.379 | 0.400 | 0.441 | 0.488 | 0.537 | 0.585 | 0.615 | 0.911 |
| `note_all`             | 787 656 | 0.260 | 0.377 | 0.397 | 0.433 | 0.479 | 0.531 | 0.594 | 0.655 | 0.989 |

### Defaults: baseline pass rate → suggested → chosen

| default          | population  | bge pass rate | suggested | chosen | pass rate at chosen | how chosen |
| ---------------- | ----------- | ------------- | --------- | ------ | ------------------- | ---------- |
| `quick`          | `query_all` | 0.9177 | 0.2583 | 0.25 | 0.9448 | suggested, rounded down to 2 decimals |
| `deep`           | `query_all` | 0.9991 | 0.1955 | 0.19 | 0.9995 | suggested, rounded down to 2 decimals |
| `fallback`       | `query_all` | 1.0000 | 0.1706 | 0.15 | 1.0000 | below the population minimum (0.1706), rounded down to 0.05 |
| `expansionFloor` | `seed_all` | 1.0000 | 0.2689 | 0.25 | 1.0000 | below the population minimum (0.2689), rounded down to 0.05 |
| `similarNotes`   | `note_all` | 0.9997 | 0.2942 | 0.29 | 0.9998 | suggested, rounded down to 2 decimals |
| `duplicates`     | `note_max` | 0.6745 | 0.7621 | 0.76 | 0.6892 | suggested, rounded down to 2 decimals |

Guards at the chosen values: `deep_filtered_first_relevant` = 0 (target 0), `quick_hit_at_3_drop` = 0 (target ≤ 1). No adjustment was needed.

harrier-0.6b is close to the bake-off: UA 0.749 vs 0.758, EN 0.875 (equal), overall 0.769 vs 0.777. The cold index took 35.5 min, about 4× harrier-270m, as the bake-off predicted. It shared the CPU with documentation agents for most of the run.

# Chosen values

The values each profile carries in `src/modules/semantic/model-profiles.ts`, pinned by `test/semantic/model-profiles.test.ts`. A deliberate retune edits the profile, the pin and this table together.

| profile        | quick | deep | fallback | expansionFloor | similarNotes | duplicates | semantic MRR overall / UA / EN | guards (deep / quick) |
| -------------- | ----- | ---- | -------- | -------------- | ------------ | ---------- | ------------------------------ | --------------------- |
| `harrier-270m` | 0.20  | 0.13 | 0.05     | 0.20           | 0.22         | 0.77       | 0.709 / 0.694 / 0.786          | 0 / 0                 |
| `granite-97m`  | 0.71  | 0.66 | 0.65     | 0.65           | 0.67         | 0.90       | 0.549 / 0.463 / 1.000          | 0 / 0                 |
| `harrier-0.6b` | 0.25  | 0.19 | 0.15     | 0.25           | 0.29         | 0.76       | 0.769 / 0.749 / 0.875          | 0 / 0                 |
| bge-micro-v2 (retired; reference) | 0.50 | 0.35 | 0.30 | 0.35        | 0.50         | 0.90       | 0.398 / 0.321 / 0.800          | 0 / 0                 |

Measured cost on this vault (949 notes, 888 note vectors; Apple M5, CPU, int8; times upper-side, see each section):

| profile        | cold index | max RSS while indexing |
| -------------- | ---------- | ---------------------- |
| `harrier-270m` | 8.8 min    | 1.32 GB                |
| `granite-97m`  | 3.5 min    | 1.20 GB                |
| `harrier-0.6b` | 35.5 min   | 2.40 GB                |

