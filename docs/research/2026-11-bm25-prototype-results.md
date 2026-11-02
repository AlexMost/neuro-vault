# BM25F in the lexical leg: prototype results (November 2026)

[The BM25 research note](2026-11-bm25-lexical-leg.md) fixed a design for [issue #132](https://github.com/AlexMost/neuro-vault/issues/132): a BM25F-style score computed at scan time inside `LexicalIndex`, replacing the ordering keys `(tier, density, backlinks, path)` with `(score, backlinks, path)`, and asked for one number before an OpenSpec change is opened: does it raise lexical MRR by **≥ 0.05** on the eval harness with **no hit@3 loss**? This document is that measurement. It is a spike: the scorer lives behind an environment switch on a throwaway branch, and nothing here is meant to merge as is.

Findings are as of 2026-11-01 for the personal vault and 2026-11-02 for the second vault (§ Second vault). Code is `main` at `16f2068` plus the prototype commit on this branch; the harness is `npm run eval` ([`eval/README.md`](../../eval/README.md)) on the personal vault's golden set (80 entries: 63 answerable, 17 controls; 25 `ua` / 14 `en` / 24 `mixed`; 29 `concept` / 18 `name` / 16 `single_token`), corpus `harrier-270m`, one `vault_sha` (`85f1454`) for every run, and then on the second vault's draft set. Both vaults are private: this report carries aggregate numbers, entry ids and rank movements, and no query text, note path or title.

## TL;DR

- **The prototype misses the acceptance line, in every configuration tried.** Shape 2 (one fielded score, the design's target) at the research doc's defaults (`k1 = 1.2`, `b = 0.75`, title 4 / heading 2 / body 1, phrase bonus 0.5) moves lexical positional MRR **0.659 → 0.619 (−0.041)** and hit@3 **0.683 → 0.651 (−0.032)**: 3 queries improve, 5 regress. The acceptance line asked for +0.05 with hit@3 not lower.
- **The best point of a ten-run sweep is a draw, not a win.** Shape 1 (the score inside the tiers, the design's fallback) with `b = 0.5` is the only configuration that keeps hit@3 (0.683 → 0.683); its MRR is 0.659 → 0.655 (−0.005), 4 wins against 2 losses. No `b` (0.3, 0.5, 0.75, 1.0), title weight (2, 4, 8) or `k1` (0.6, 1.2) lifts Shape 2 above the baseline.
- **The hybrid result does not improve either.** Fused production deep, the list an agent receives, goes from MRR 0.829 to 0.809 (Shape 2) or 0.813 (best Shape 1); hit@3 stays at 0.905 under Shape 2 and drops to 0.889 under Shape 1. The semantic leg absorbs most of the lexical reordering, so the hybrid moves less than the leg, but in the same direction.
- **The losses are the research doc's risk 2, measured.** On name lookups a short note with several body mentions of the name outscores the entity note whose title *is* the name; on an exact-title query several notes carry the phrase in their titles, BM25F saturates them to nearly equal scores, and tiny length differences then favour short stub notes over the note titled exactly the query. The old `density` key encoded "the title is exactly the query"; BM25F has no such signal, and neither `b` nor the title weight gives it one.
- **The second vault, the shape the scorer was designed for, reads the same way.** On a ~4 900-note private vault (long mirrored wiki pages plus short synthesised cards; a 28-query agent-drafted set, see § Second vault) Shape 2 moves lexical positional MRR **0.473 → 0.409 (−0.064)** and hit@3 **0.500 → 0.429 (−0.071)**, 2 wins against 4 losses; fused production deep goes 0.800 → 0.740 (−0.060). The best sweep point there (Shape 1, `b = 0.3`) is again a draw with a loss attached: −0.027 MRR, hit@3 unchanged. The regressed queries are the one-word entity names the "card vs mirror page" shape is made of: with the name in 160–300 notes, idf is low and saturation puts every title-hit note within 0.3 of a score, so mention count and length decide and the exactly-titled card drops. Half of that set (14 of 28) misses under every scorer because the candidate set is empty or does not hold the labelled note: on that vault the lexical losses are recall first, which is #131's question, not #132's.
- **Cost is small but not zero**: about +8 ms per search on 1 009 notes (33 → 42 ms, of which most is the per-search stat pass of the freshness model), no retained heap. On the ~4 900-note second vault the bench is noisier (81–113 ms per search for `tiers`, 104–177 ms for `bm25f` over four alternating passes, a paired delta of +3 to +64 ms), again with no retained heap.

## Setup

- **Code.** `src/lib/obsidian/lexical/scorer.ts` reads `NEURO_VAULT_LEXICAL_SCORER` (`tiers` | `bm25f` | `bm25-tiers`) and the knobs `NEURO_VAULT_BM25_K1`, `_B`, `_W_TITLE`, `_W_HEADING`, `_W_BODY`, `_PHRASE`. `rankNotes` computes the score after candidate generation, over the ranked set (after `allowed`): `N`, `df_t` (notes where the token occurs at a word start anywhere) and `avglen` (tokens per note) are counted on each call; `tf_{t,f}` counts word-start occurrences per field with the field weight applied before saturation; `idf` is the Lucene form; the phrase bonus multiplies when some unit holds the query as a phrase. The candidate set, the evidence rows, the query-variant RRF (#265), the backlink and path tie-breaks and the `search_notes` contract are unchanged; `tiers` is byte-identical to `main` (the full suite passes with the switch off, 3 274 tests). The eval report's `config` records `lexical_scorer` and `lexical_bm25f`.
- **Shapes.** `bm25f` orders by `(score, backlinks, path)` — Shape 2 in the research doc. `bm25-tiers` keeps the tier first and uses the score where `density` was — Shape 1.
- **Runs.** The harness's baseline matrix (lexical positional and production; fused positional, production quick, production deep) for `tiers` and for `bm25f` at the defaults; lexical positional for each sweep point; fused positional, fused production deep and lexical production for the best sweep point. Reports are in the vault's `.neuro-vault/eval/results/`. The first report of a session makes the vault's `git status` non-clean, so every report after the first carries `vault_sha …-dirty`; the only untracked files are the harness's own reports and the notes did not change, so the runs are a paired comparison.
- **Second vault (added 2026-11-02).** A second, larger private vault outside this repository, read-only for the run: ~4 900 scoped notes (an external wiki mirrored page by page, plus short synthesised entity cards; `avglen` 496 tokens) and a 57-note companion vault, both with a built `harrier-270m` corpus. That checkout is not a git repository, so `vault_sha` is `n/a` on every report; the notes did not change between runs. **The golden set is a draft an agent built on 2026-11-01 for an agent-level A/B, not a curated set**: 35 entries across both vaults (30 answerable + 5 controls; 12 `concept` / 12 `name` / 6 `single_token`; 15 `en` / 13 `ua` / 7 `mixed`), 7 of them marked low confidence by its author, relevance judged as "notes dedicated to the entity or topic". A small script beside the vault splits it per vault for the harness (strip the vault prefix, drop the other vault's paths; an answerable entry left with no path is dropped, not turned into a control): the large vault keeps 28 answerable + 5 controls (two `concept` entries dropped), the companion 27 + 5.
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

Both are the research doc's risk 2 ("Shape 2 hurts name lookups on small personal vaults"); the set was expected to guard against it, and it did. The mechanism the scorer targets — a long mirror page with a passing heading mention beating a short card — was found once on this set (q032, a win) and is the shape the second vault's entries were to be built around.

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
- On the second vault (§ Second vault, measured a day later on a draft set) it settles the direction, not the second decimal: both shapes lose there too, on the same mechanism, and half of that set cannot move under any scorer because the lexical leg never produces the labelled note as a candidate. That half is #131's question (recall: AND within one unit, prefix-only inflection), and the FTS5 baseline script the research doc asks for is still the right next measurement; this spike only says that the ranking half is not where BM25F wins either.
- If the second vault's set does move, the scorer needs an **exact-title term** before it can pass the guard here: for instance keep the title tier's `density` as a key above the score (a title that is entirely the query first), or add a bonus when the query covers the whole title. Both are cheap to try on this branch.

## Second vault (large, private)

The set the scorer was designed to move, measured on 2026-11-02 on the vault described in § Setup. Baseline (`tiers`, lexical positional): MRR 0.473, hit@1 0.429, hit@3 0.500, recall@10 0.454 on 28 answerable entries; control hit rate 0.000 on every lexical run (controls return nothing, so they cannot move).

**What the set can and cannot show.** Of the 28 answerable entries, 14 miss under the baseline and under every scorer: 9 return no notes at all (the AND never matches a unit), 4 return fewer than ten notes none of which is labelled (the labelled note is not a candidate), and 1 returns ten unlabelled notes (a ranking miss, the only one). Every `concept` entry but one is in that half (class MRR 0.025 before and after), so the losses the research note measured on that vault (#131: MRR 0.167 on 14 queries) are recall losses first; a scorer can only reorder the other 14 entries, which are `name` and `single_token` lookups. One rank move 1 → 2 is 0.018 MRR on this set and 1 → miss is 0.036, so the +0.05 line is about two queries. Seven entries carry the author's low-confidence mark, and in one regressed entry (p006) the draft labels the long page while the short card the scorer promoted is arguably also an answer. The set is good for the direction of a change and for its mechanism; it is not good for a second decimal, and it should not be read as the curated set #131 asks for.

### Lexical leg alone

Shape 2 at the defaults (`bm25f`), positional (top-10, threshold 0):

| slice               |   n | MRR before | MRR after |      Δ | hit@3 before | hit@3 after |      Δ | recall@10 before | recall@10 after |      Δ |
| ------------------- | --: | ---------: | --------: | -----: | -----------: | ----------: | -----: | ---------------: | --------------: | -----: |
| overall             |  28 |      0.473 |     0.409 | −0.064 |        0.500 |       0.429 | −0.071 |            0.454 |           0.395 | −0.059 |
| lang: ua            |  11 |      0.386 |     0.341 | −0.045 |        0.364 |       0.364 |  0.000 |            0.368 |           0.345 | −0.023 |
| lang: en            |  11 |      0.727 |     0.609 | −0.118 |        0.818 |       0.636 | −0.182 |            0.741 |           0.614 | −0.127 |
| lang: mixed         |   6 |      0.167 |     0.167 |  0.000 |        0.167 |       0.167 |  0.000 |            0.083 |           0.083 |  0.000 |
| class: concept      |  10 |      0.025 |     0.025 |  0.000 |        0.000 |       0.000 |  0.000 |            0.025 |           0.025 |  0.000 |
| class: name         |  12 |      0.625 |     0.558 | −0.067 |        0.667 |       0.583 | −0.083 |            0.625 |           0.583 | −0.042 |
| class: single_token |   6 |      0.917 |     0.750 | −0.167 |        1.000 |       0.833 | −0.167 |            0.825 |           0.633 | −0.192 |

hit@1 0.429 → 0.357, hit@3 0.500 → 0.429, hit@5 0.536 → 0.500. Production (quick floors) reads identically: MRR 0.473 → 0.409, hit@3 0.500 → 0.429.

Per-query, first relevant rank (positional):

| id   | class        | lang | before | after | what moved                                                                                                                                                                                                                                                       |
| ---- | ------------ | ---- | -----: | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| p002 | single_token | en   |      2 |     1 | win — an unrelated person note whose title word merely *starts* with the acronym (the word-start prefix rule) drops from first place; idf and tf demote a spurious prefix hit                                                                                     |
| p006 | name         | en   |      1 |     2 | loss — a short card with repeated body mentions of the ticket key overtakes the labelled long page (mechanism A; the card is arguably an answer too, see the reliability note)                                                                                   |
| p010 | name         | en   |      2 |     1 | win — the labelled page with both words of the name in its title and many body mentions overtakes an unlabelled page that holds the exact phrase in its title                                                                                                    |
| p012 | name         | en   |      1 |     5 | loss — the team card and the page titled exactly with the one-word name fall behind three pages that carry the name in a longer title, a heading and four or five body mentions (mechanism B + saturation, below)                                                 |
| p026 | single_token | ua   |      1 |     2 | loss — a long research page with the token in its title and many body mentions overtakes the two feature pages labelled relevant (mechanism A)                                                                                                                   |
| p029 | single_token | en   |      1 |  miss | loss — the two product cards titled with the acronym fall out of the top ten; folder index notes and a 3 174-token page with 237 body mentions and no title hit take the top (saturation, below)                                                                  |

**Saturation, measured.** The regressed names are common in a wiki mirror. For p012 the name occurs at a word start in 160 of ~4 900 notes (idf 3.41); every title-hit note scores between 6.5 and 7.3, and the top ten are separated by 0.33, so one extra body mention or 100 fewer tokens decides. A 72-token note with six body mentions and no title hit scores 7.01, above every title-hit note longer than 300 tokens. For p029 the acronym occurs in 294 notes (idf 2.81); the top nine, all title hits, lie between 5.99 and 6.03, and the 3 174-token page with 237 mentions scores 6.02 with no title hit at all. `k1 = 1.2` saturates tf by the third mention, the title weight 4 adds one saturated unit, and a low idf scales the whole thing down: on a corpus where the entity name is on hundreds of pages, BM25F cannot tell the page *about* the entity from a page that mentions it, and the tiers' "title first, shortest title first" rule could.

Sweep (lexical positional, overall; baseline MRR 0.473, hit@1 0.429, hit@3 0.500):

| scorer       | knobs             |   MRR |      Δ | hit@1 | hit@3 |      Δ | wins | losses | note                                                                            |
| ------------ | ----------------- | ----: | -----: | ----: | ----: | -----: | ---: | -----: | ------------------------------------------------------------------------------- |
| `bm25f`      | defaults (b 0.75) | 0.409 | −0.064 | 0.357 | 0.429 | −0.071 |    2 |      4 | above                                                                           |
| `bm25f`      | b 0.3             | 0.429 | −0.045 | 0.357 | 0.500 |  0.000 |    2 |      3 | p012 recovers to 1, p026 to 1; p027 (single_token, ua) 1 → 2 instead; p029 still a miss |
| `bm25f`      | title 8           | 0.411 | −0.063 | 0.357 | 0.429 | −0.071 |    2 |      4 | p012 1 → 4 instead of 5; nothing else moves                                     |
| `bm25-tiers` | b 0.5             | 0.420 | −0.054 | 0.357 | 0.464 | −0.036 |    2 |      3 | p003 (concept, ua) 4 → 2 within the body tier; p012 1 → 4, p026 1 → 2, p029 1 → miss |
| `bm25-tiers` | b 0.3 (best)      | 0.446 | −0.027 | 0.393 | 0.500 |  0.000 |    2 |      2 | p003 4 → 2, p010 2 → 1; p027 1 → 2, p029 1 → miss                               |

Title weight 8 does not help because the regressed queries' competitors also have title hits. Lower `b` helps, as on the personal vault, because it stops punishing the longer entity pages; it does not rescue p029, where the cards' problem is not length but that 294 notes saturate to the same score.

On the 27-entry companion vault (57 notes) `bm25f` at the defaults is identical to `tiers` on every entry (MRR 0.556, hit@3 0.556); `bm25-tiers` with `b = 0.5` moves one entry 1 → 2 (MRR 0.537). Too small to count, reported for completeness.

### Hybrid result (fused RRF)

| run                   | scorer         | MRR before | MRR after |      Δ | hit@1 before | hit@1 after | hit@3 before | hit@3 after |      Δ | recall@10 before | recall@10 after | wins | losses |
| --------------------- | -------------- | ---------: | --------: | -----: | -----------: | ----------: | -----------: | ----------: | -----: | ---------------: | --------------: | ---: | -----: |
| fused production deep | bm25f defaults |      0.800 |     0.740 | −0.060 |        0.714 |       0.643 |        0.857 |       0.821 | −0.036 |            0.861 |           0.854 |    1 |      5 |

The semantic leg lifts the `concept` class from 0.025 to 0.690 here (it answers the recall half the lexical leg misses), and under fusion the lexical regressions survive as one-place shifts: p006 1 → 2, p012 1 → 5, p029 1 → 3, p018 (concept, ua) 2 → 3, p003 5 → 6, against one win (p010 2 → 1). Control noise is unchanged (hit rate 0.400, mean 1.80 on both: two of the five controls get semantic hits regardless of the scorer).

### Cost on the larger vault

The same bench as § Cost (the 33 golden calls, `LexicalIndex.search` warm, `noteCap` 10, four alternating passes of five rounds, GC forced before each pass): `tiers` 81–113 ms per search, `bm25f` 104–177 ms, paired deltas +3, +17, +22 and +64 ms. The spread is the machine, not the scorer (the two `tiers` passes differ by 30 ms between themselves), so read it as "+10 to +20 ms on ~4 900 notes, occasionally more", the same order as the +8 ms on 1 009 notes. `heapUsed` returns to 148 MB before every pass: nothing is retained between searches. First-query (cold parse) time was not measured here; the scorer does not touch the parse.

### Verdict on this set

**Misses**, by more than on the personal vault: Shape 2 −0.064 MRR and −0.071 hit@3, the best Shape 1 point −0.027 and 0.000. The mechanism is the personal vault's mechanism B made worse by corpus size: an entity name that appears on hundreds of mirrored pages has a low idf and a saturated tf, so the exactly-titled card has no margin left over the pages that mention it. The shape #132 hypothesised (long pages beating short cards by length) was found in one entry (p010, a win); the opposite shape (short cards losing to pages with more mentions) in four. The reliability caveat above applies in full: this is a 28-entry agent draft, two queries wide at the acceptance line, and half of it is out of any scorer's reach. The direction is the same on both vaults and on both shapes, and that is what the set can say.

## Reproducing

```sh
# baseline, then the prototype, on one vault state
npm run eval -- --vault <vault> --pipeline lexical
NEURO_VAULT_LEXICAL_SCORER=bm25f npm run eval -- --vault <vault> --pipeline lexical
NEURO_VAULT_LEXICAL_SCORER=bm25-tiers NEURO_VAULT_BM25_B=0.5 npm run eval -- --vault <vault> --pipeline lexical
```

Diff two reports by `id` on `first_relevant_rank` and the `metrics` slices; the reports quote queries and paths, so keep them in the vault's repository. The second vault is not a git repository, so its reports carry `vault_sha: null`; its golden set is split per vault from a draft kept beside the vault by a script that also stays there, not in this repository.
