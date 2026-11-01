# BM25F in the lexical leg: prototype results (November 2026)

[The BM25 research note](2026-11-bm25-lexical-leg.md) fixed a design for [issue #132](https://github.com/AlexMost/neuro-vault/issues/132): a BM25F-style score computed at scan time inside `LexicalIndex`, replacing the ordering keys `(tier, density, backlinks, path)` with `(score, backlinks, path)`, and asked for one number before an OpenSpec change is opened: does it raise lexical MRR by **≥ 0.05** on the eval harness with **no hit@3 loss**? This document is that measurement. It is a spike: the scorer lives behind an environment switch on a throwaway branch, and nothing here is meant to merge as is.

Findings are as of 2026-11-01. Code is `main` at `16f2068` plus the prototype commit on this branch; the harness is `npm run eval` ([`eval/README.md`](../../eval/README.md)) on the personal vault's golden set (80 entries: 63 answerable, 17 controls; 25 `ua` / 14 `en` / 24 `mixed`; 29 `concept` / 18 `name` / 16 `single_token`), corpus `harrier-270m`, one `vault_sha` (`85f1454`) for every run. The vault is private: this report carries aggregate numbers, entry ids and rank movements, and no query text, note path or title.

## TL;DR

- **The prototype misses the acceptance line, in every configuration tried.** Shape 2 (one fielded score, the design's target) at the research doc's defaults (`k1 = 1.2`, `b = 0.75`, title 4 / heading 2 / body 1, phrase bonus 0.5) moves lexical positional MRR **0.659 → 0.619 (−0.041)** and hit@3 **0.683 → 0.651 (−0.032)**: 3 queries improve, 5 regress. The acceptance line asked for +0.05 with hit@3 not lower.
- **The best point of a ten-run sweep is a draw, not a win.** Shape 1 (the score inside the tiers, the design's fallback) with `b = 0.5` is the only configuration that keeps hit@3 (0.683 → 0.683); its MRR is 0.659 → 0.655 (−0.005), 4 wins against 2 losses. No `b` (0.3, 0.5, 0.75, 1.0), title weight (2, 4, 8) or `k1` (0.6, 1.2) lifts Shape 2 above the baseline.
- **The hybrid result does not improve either.** Fused production deep, the list an agent receives, goes from MRR 0.829 to 0.809 (Shape 2) or 0.813 (best Shape 1); hit@3 stays at 0.905 under Shape 2 and drops to 0.889 under Shape 1. The semantic leg absorbs most of the lexical reordering, so the hybrid moves less than the leg, but in the same direction.
- **The losses are the research doc's risk 2, measured.** On name lookups a short note with several body mentions of the name outscores the entity note whose title *is* the name; on an exact-title query several notes carry the phrase in their titles, BM25F saturates them to nearly equal scores, and tiny length differences then favour short stub notes over the note titled exactly the query. The old `density` key encoded "the title is exactly the query"; BM25F has no such signal, and neither `b` nor the title weight gives it one.
- **What the harness cannot tell.** This is the personal vault, which the research doc designates the *regression guard* for name lookups; the set the scorer was meant to move (the corporate vault's "short card vs long mirror page" entries) is not available here. On this set the mechanism the scorer targets (length normalisation and field weights against long mirror pages) finds few queries to help and the mechanism it weakens (exact-title preference) is common. The verdict is "no gain and a small loss on the guard set", not "no gain anywhere".
- **Cost is small but not zero**: about +8 ms per search on 1 009 notes (33 → 42 ms, of which most is the per-search stat pass of the freshness model), no retained heap.

## Setup

- **Code.** `src/lib/obsidian/lexical/scorer.ts` reads `NEURO_VAULT_LEXICAL_SCORER` (`tiers` | `bm25f` | `bm25-tiers`) and the knobs `NEURO_VAULT_BM25_K1`, `_B`, `_W_TITLE`, `_W_HEADING`, `_W_BODY`, `_PHRASE`. `rankNotes` computes the score after candidate generation, over the ranked set (after `allowed`): `N`, `df_t` (notes where the token occurs at a word start anywhere) and `avglen` (tokens per note) are counted on each call; `tf_{t,f}` counts word-start occurrences per field with the field weight applied before saturation; `idf` is the Lucene form; the phrase bonus multiplies when some unit holds the query as a phrase. The candidate set, the evidence rows, the query-variant RRF (#265), the backlink and path tie-breaks and the `search_notes` contract are unchanged; `tiers` is byte-identical to `main` (the full suite passes with the switch off, 3 274 tests). The eval report's `config` records `lexical_scorer` and `lexical_bm25f`.
- **Shapes.** `bm25f` orders by `(score, backlinks, path)` — Shape 2 in the research doc. `bm25-tiers` keeps the tier first and uses the score where `density` was — Shape 1.
- **Runs.** The harness's baseline matrix (lexical positional and production; fused positional, production quick, production deep) for `tiers` and for `bm25f` at the defaults; lexical positional for each sweep point; fused positional, fused production deep and lexical production for the best sweep point. Reports are in the vault's `.neuro-vault/eval/results/`. The first report of a session makes the vault's `git status` non-clean, so every report after the first carries `vault_sha …-dirty`; the only untracked files are the harness's own reports and the notes did not change, so the runs are a paired comparison.
- **Read.** Positional runs: top-10 at threshold 0, where relevant notes rank. `hit@1` and `hit@5` are derived from the per-query `first_relevant_rank` in the reports (the harness prints hit@3, MRR and recall@10). Controls cannot move under a ranking-only change, and did not (control hit rate 0.059, mean 0.12 on both lexical runs).

## Lexical leg alone

### Shape 2 at the defaults (`bm25f`, k1 1.2, b 0.75, title 4 / heading 2 / body 1, phrase 0.5)

Positional (top-10, threshold 0):

| slice               |   n | MRR before | MRR after |      Δ | hit@3 before | hit@3 after |      Δ | recall@10 before | recall@10 after |      Δ |
| ------------------- | --: | ---------: | --------: | -----: | -----------: | ----------: | -----: | ---------------: | --------------: | -----: |
| overall             |  63 |      0.659 |     0.619 | −0.041 |        0.683 |       0.651 | −0.032 |            0.605 |           0.572 | −0.033 |
| lang: ua            |  25 |      0.440 |     0.420 | −0.020 |        0.440 |       0.440 |  0.000 |            0.353 |           0.353 |  0.000 |
| lang: en            |  14 |      0.821 |     0.702 | −0.120 |        0.857 |       0.714 | −0.143 |            0.801 |           0.736 | −0.065 |
| lang: mixed         |  24 |      0.793 |     0.777 | −0.017 |        0.833 |       0.833 |  0.000 |            0.753 |           0.704 | −0.049 |
| class: concept      |  29 |      0.576 |     0.550 | −0.026 |        0.586 |       0.552 | −0.034 |            0.442 |           0.434 | −0.009 |
| class: name         |  18 |      0.778 |     0.701 | −0.076 |        0.833 |       0.778 | −0.056 |            0.750 |           0.694 | −0.056 |
| class: single_token |  16 |      0.678 |     0.650 | −0.028 |        0.688 |       0.688 |  0.000 |            0.737 |           0.685 | −0.053 |

hit@1 0.619 → 0.556, hit@3 0.683 → 0.651, hit@5 0.714 → 0.698. Production (quick floors, cap 5) reads the same: MRR 0.657 → 0.614, hit@3 0.683 → 0.651.

Per-query, first relevant rank (positional):

| id   | class        | lang  | before | after | what moved                                                                                                                       |
| ---- | ------------ | ----- | -----: | ----: | -------------------------------------------------------------------------------------------------------------------------------- |
| q009 | concept      | en    |      1 |     5 | loss — four relevant notes titled with the query phrase fall behind four stub notes that also carry it in the title (mechanism B) |
| q014 | concept      | ua    |      1 |     2 | loss — a note with the terms in a long body paragraph overtakes the entity note                                                   |
| q032 | concept      | mixed |      2 |     1 | win — a relevant reflection note rises above a long unrelated note that matched a broad variant                                   |
| q039 | name         | mixed |      1 |     2 | loss — a daily note with repeated body mentions overtakes the project's notes (mechanism A)                                       |
| q040 | name         | en    |      1 |     8 | loss — five daily notes with repeated body mentions overtake the project note titled with the name (mechanism A)                 |
| q054 | concept      | mixed |      5 |     4 | win — one unrelated note drops out of the top                                                                                    |
| q059 | single_token | mixed |      5 |     4 | win — one unrelated note drops out of the top                                                                                    |
| q060 | single_token | mixed |      1 |     2 | loss — a long profile note with many body mentions overtakes the design note                                                      |

### Sweep (lexical positional, overall slice; baseline MRR 0.659, hit@1 0.619, hit@3 0.683, recall@10 0.605)

| scorer       |  k1 |    b | title | heading | body |   MRR |      Δ | hit@1 | hit@3 |      Δ | recall@10 | wins | losses |
| ------------ | --: | ---: | ----: | ------: | ---: | ----: | -----: | ----: | ----: | -----: | --------: | ---: | -----: |
| bm25f        | 1.2 | 0.75 |     4 |       2 |    1 | 0.619 | −0.041 | 0.556 | 0.651 | −0.032 |     0.572 |    3 |      5 |
| bm25f        | 1.2 | 0.30 |     4 |       2 |    1 | 0.643 | −0.016 | 0.587 | 0.667 | −0.016 |     0.602 |    4 |      3 |
| bm25f        | 1.2 | 0.50 |     4 |       2 |    1 | 0.644 | −0.015 | 0.587 | 0.683 |  0.000 |     0.589 |    4 |      3 |
| bm25f        | 1.2 | 1.00 |     4 |       2 |    1 | 0.614 | −0.046 | 0.556 | 0.651 | −0.032 |     0.540 |    4 |      6 |
| bm25f        | 1.2 | 0.75 |     2 |       2 |    1 | 0.619 | −0.041 | 0.556 | 0.651 | −0.032 |     0.559 |    3 |      5 |
| bm25f        | 1.2 | 0.75 |     8 |       2 |    1 | 0.636 | −0.023 | 0.587 | 0.651 | −0.032 |     0.577 |    3 |      3 |
| bm25f        | 1.2 | 0.50 |     8 |       2 |    1 | 0.640 | −0.019 | 0.587 | 0.667 | −0.016 |     0.591 |    4 |      3 |
| bm25f        | 0.6 | 0.75 |     4 |       2 |    1 | 0.619 | −0.041 | 0.556 | 0.651 | −0.032 |     0.572 |    3 |      5 |
| bm25-tiers   | 1.2 | 0.75 |     4 |       2 |    1 | 0.648 | −0.011 | 0.603 | 0.667 | −0.016 |     0.587 |    3 |      2 |
| **bm25-tiers** | 1.2 | **0.50** |     4 |       2 |    1 | **0.655** | **−0.005** | 0.603 | **0.683** | **0.000** |     0.599 |    4 |      2 |

Reading the sweep: lowering `b` helps and raising it hurts (less length normalisation protects the longer entity notes), the title weight barely matters once a title match is already worth four body mentions, `k1` does not matter at all on this set, and keeping the tier as the first key recovers most of the loss — which says the loss comes from field weights replacing the lexicographic tiers, not from the score itself.

### Best point: Shape 1 with b 0.5 (`bm25-tiers`)

| slice               |   n | MRR before | MRR after |      Δ | hit@3 before | hit@3 after |     Δ | recall@10 before | recall@10 after |      Δ |
| ------------------- | --: | ---------: | --------: | -----: | -----------: | ----------: | ----: | ---------------: | --------------: | -----: |
| overall             |  63 |      0.659 |     0.655 | −0.005 |        0.683 |       0.683 | 0.000 |            0.605 |           0.599 | −0.007 |
| lang: ua            |  25 |      0.440 |     0.444 | +0.004 |        0.440 |       0.440 | 0.000 |            0.353 |           0.363 | +0.010 |
| lang: en            |  14 |      0.821 |     0.786 | −0.036 |        0.857 |       0.857 | 0.000 |            0.801 |           0.748 | −0.054 |
| lang: mixed         |  24 |      0.793 |     0.798 | +0.004 |        0.833 |       0.833 | 0.000 |            0.753 |           0.757 | +0.003 |
| class: concept      |  29 |      0.576 |     0.578 | +0.002 |        0.586 |       0.586 | 0.000 |            0.442 |           0.440 | −0.003 |
| class: name         |  18 |      0.778 |     0.778 |  0.000 |        0.833 |       0.833 | 0.000 |            0.750 |           0.722 | −0.028 |
| class: single_token |  16 |      0.678 |     0.656 | −0.021 |        0.688 |       0.688 | 0.000 |            0.737 |           0.748 | +0.010 |

Per query: q004 (single_token, ua) miss → 9, q032 2 → 1, q054 5 → 4, q059 5 → 4; q009 1 → 2 and q052 (single_token, mixed) 1 → 2. The wins are reorderings inside the body tier where the score is a better key than unit density; the losses are the two exact-title cases again, now only one place.

## Hybrid result (fused RRF)

| run                        | scorer                      | MRR before | MRR after |      Δ | hit@1 before | hit@1 after | hit@3 before | hit@3 after |      Δ | recall@10 before | recall@10 after | wins | losses |
| -------------------------- | --------------------------- | ---------: | --------: | -----: | -----------: | ----------: | -----------: | ----------: | -----: | ---------------: | --------------: | ---: | -----: |
| fused positional           | bm25f defaults              |      0.818 |     0.790 | −0.027 |        0.714 |       0.667 |        0.905 |       0.905 |  0.000 |            0.784 |           0.775 |    1 |      6 |
| fused production deep      | bm25f defaults              |      0.829 |     0.809 | −0.019 |        0.746 |       0.714 |        0.905 |       0.905 |  0.000 |            0.769 |           0.757 |    1 |      5 |
| fused production quick     | bm25f defaults              |      0.836 |     0.812 | −0.024 |        0.762 |       0.714 |        0.921 |       0.921 |  0.000 |            0.648 |           0.626 |    1 |      4 |
| fused positional           | bm25-tiers b 0.5 (best)     |      0.818 |     0.794 | −0.023 |        0.714 |       0.683 |        0.905 |       0.889 | −0.016 |            0.784 |           0.785 |    1 |      6 |
| fused production deep      | bm25-tiers b 0.5 (best)     |      0.829 |     0.813 | −0.015 |        0.746 |       0.730 |        0.905 |       0.889 | −0.016 |            0.769 |           0.766 |    1 |      5 |

Under fusion the one consistent win is q001 (name, ua, 2 → 1) and the consistent losses are q002 (name, ua, 1 → 2), q038 (concept, mixed, 4 → 5) and q062 (single_token, ua, 2 → 3), each by one place: RRF turns a lexical reordering into a one-place shift where the semantic leg does not agree. Control noise is unchanged (production deep: hit rate 0.176, mean 1.06 on both), as a ranking-only change predicts.

## Why it loses: two mechanisms, measured on the regressed queries

A private probe (session scratchpad, not in the repo) recomputed the score components for the regressed queries over the whole vault (N = 1 009, average 325 tokens per note).

- **A. Frequency beats the entity note on name lookups.** For the name token of q040 (`df` 49, `idf` 3.02), the four top-scoring notes are daily notes of 59–81 tokens with 3–7 body mentions (score 5.7–6.2); the project note titled with the name has 506 tokens, one title hit, one heading hit and three body mentions, and scores 5.58. A title weight of 4 makes a title hit worth four body mentions, which a short daily note clears with ease, and `b = 0.75` taxes the longer entity note by a factor 1.42 before saturation. Raising the title weight to 8 recovers one of the two name queries; lowering `b` recovers the other; neither lifts the slice above the baseline, because the same knobs demote other answers.
- **B. Exact titles have no signal.** For q009 (two tokens, `df` 109 / `idf` 2.22 for the first), ten notes carry the phrase in their title. BM25F scores them 4.49–4.68, a spread decided almost entirely by length; the four relevant notes (resources with that title and some body) land behind four short "read later" stubs with the same title. Under `tiers`, `density` ordered title matches by how much of the title the query covers, so the note titled *exactly* the query always came first. BM25F has no term for that, and the phrase bonus does not help because every one of these titles holds the phrase.

Both are the research doc's risk 2 ("Shape 2 hurts name lookups on small personal vaults"); the set was expected to guard against it, and it did. The mechanism the scorer targets — a long mirror page with a passing heading mention beating a short card — was found once on this set (q032, a win) and is the shape the corporate vault's entries were to be built around.

## Cost

Measured with a scratchpad script over `LexicalIndex.search` for all 80 golden calls, five rounds each after a warm pass, on the 1 009-note vault (Apple M5, Node 24.13):

| scorer | ms per search (two measurements) | retained heap |
| ------ | -------------------------------: | ------------: |
| tiers  |                     33.3 / 25.3 |          none |
| bm25f  |                     42.2 / 32.9 |          none |

About +8 ms per search, roughly +30 %, almost all of it the extra occurrence counting over every note for `df` (the scan already visits every unit; the prototype does it a second time instead of folding the counts into `matchUnit`). The bulk of each search is the freshness model's stat of every file. Heap: the prototype keeps one integer per parsed note in a `WeakMap`; no persistent structure, and `heapUsed` after the runs differs only by transient garbage.

## Verdict

**Misses.** The acceptance line was lexical positional MRR +0.05 with no hit@3 loss. The design's target shape gives −0.041 and −0.032; the best of ten configurations, the fallback shape with `b = 0.5`, gives −0.005 and 0.000 — a draw on the personal set at a cost of +30 % search time. Nothing in the sweep suggests a knob setting on the other side of the line: the losing mechanisms are structural (frequency against entity notes, no exact-title signal), not a matter of `b`.

What this does and does not settle:

- It settles that BM25F **as designed** should not replace the tiers on a vault of this shape, and that Shape 1 is not worth its cost on this set either.
- It does **not** settle whether the corporate vault's losses (#131: lexical MRR 0.167) are ranking losses BM25F would recover; that needs its golden set, extended with the "card vs mirror page" entries the research doc asks for, and the FTS5 baseline script that splits ranking from recall. The research doc's own stop criterion was written for that set, with this one as the guard; the guard failed before the target was measured.
- If the corporate set does move, the scorer needs an **exact-title term** before it can pass the guard here: for instance keep the title tier's `density` as a key above the score (a title that is entirely the query first), or add a bonus when the query covers the whole title. Both are cheap to try on this branch.

## Reproducing

```sh
# baseline, then the prototype, on one vault state
npm run eval -- --vault <vault> --pipeline lexical
NEURO_VAULT_LEXICAL_SCORER=bm25f npm run eval -- --vault <vault> --pipeline lexical
NEURO_VAULT_LEXICAL_SCORER=bm25-tiers NEURO_VAULT_BM25_B=0.5 npm run eval -- --vault <vault> --pipeline lexical
```

Diff two reports by `id` on `first_relevant_rank` and the `metrics` slices; the reports quote queries and paths, so keep them in the vault's repository.
