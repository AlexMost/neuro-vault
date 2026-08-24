<!--
Raw capture of superpowers:brainstorming output.
Conducted verbally in-chat (opsx:explore session, 2026-08-10): code-verified
diagnosis of the threshold wiring, then three design forks resolved via
explicit user decisions. Source task: vault note
a private vault task note on splitting the per-leg thresholds.
-->

# Brainstorm — split-leg-thresholds

## Background

A 2026-08-10 field report (post RRF-weighting fixes) produced a calibration
curve for `search_notes` on `["ретеншн алертів", "retention alerts"]` (deep):
expansion candidates at similarity 0.9206 / 0.9259 / 0.9272 / 0.9341, semantic
hits at 0.7749–0.7964.

| `threshold` | expansion | semantic |
|---|---|---|
| default | 4 | 8 |
| `0.82` | 4 | 8 |
| `0.93` | **1** (0.9341 survives) | 8 |
| `0.99` | 0 | 8 |

The tool doc says `threshold` is "SEMANTIC LEG ONLY. Default 0.5 (quick) /
0.35 (deep)". The curve shows it visibly filtering the expansion leg and never
the semantic leg. The vault task's original diagnosis called this an
*inversion* (threshold wired to the wrong leg).

## Code verification (changed the diagnosis)

Read `src/modules/semantic/retrieval-policy.ts` (both `executeRetrieval` and
`executeMultiRetrieval` — symmetric):

- **Semantic leg** — `threshold` IS passed to `findNeighbors` (Step 1,
  :100/:265). But Step 2 (:105/:268): if 0 hits and
  `threshold > FALLBACK_THRESHOLD (0.3)`, the search is **silently retried at
  0.3**. An explicit threshold that filters everything is cancelled without a
  trace.
- **Block search (deep)** — the same `threshold` goes to `findBlockNeighbors`
  (Step 4, :130/:312) on the query↔block scale; Step 4b backfills 1 best block
  per starved seed at threshold 0.
- **Expansion leg** — the same `threshold` goes to `computeRelatedPerSeed`
  (Step 5, :177/:375 → :71). No fallback → the only place the knob bites
  visibly.

So: **not an inversion — one shared threshold reaching three legs on three
incomparable scales, with a silent fallback masking it on the semantic leg.**
Every tested value (0.82/0.93/0.99) sat above the entire semantic band
(0.7749–0.7964), so each run fully filtered → fallback → identical 8 hits.
A value inside the band (~0.78) would have partially filtered the semantic
leg; the report never tested there.

Consequence for scope: the semantic-side fix is a fallback-condition change,
not a re-wiring; the expansion-side fix is replacing one argument
(`computeRelatedPerSeed`'s `threshold`) with a named floor.

## Decision chain

**Q1 — What happens to the silent fallback (retry at 0.3) when an explicit
threshold filters out all semantic hits?**
Options: (a) fallback only for default thresholds; (b) remove fallback
entirely; (c) keep always but surface in `query_stats`.
**Decision: (a) fallback only when `input.threshold === undefined`.** An
explicit threshold is a hard filter with no rescue; default behavior
(0.5 quick / 0.35 deep, rescued at 0.3 on full miss) is unchanged.

**Q2 — Expansion floor: internal constant or contract parameter?**
Options: (a) new optional contract parameter (working name `expansion_floor`)
with a behavior-preserving default; (b) internal constant in retrieval-policy.
**Decision: (a) contract parameter.** Transparent, and the report's
calibration curve becomes reproducible through the API. The bug existed
precisely because the safeguard was invisible and shared.

**Q3 — Should the user threshold filter blocks inside notes?** (Today, deep
mode filters blocks by the user threshold, with a 1-block-per-seed backfill.)
Options: (a) no — threshold applies to note score only, deep blocks filter by
the internal mode default (0.35), backfill guarantee stays; (b) keep as is.
**Decision: (a) note score only.** Removes the third scale (query↔block
0.60–0.85) from under the same knob — the same disease as the expansion
coupling.

## Acceptance restatement (original was internally contradictory)

The vault task originally required `threshold: 0.93` to *both* keep the 0.9341
expansion note *and* (via a new test) have `threshold: 0.99` yield zero
semantic hits. Those conflict: an honest threshold of 0.93 > 0.7964 yields
zero semantic seeds, and with no seeds the expansion leg cannot exist.
Restated:

- `threshold: 0.99` on the report's query pair (deep) → zero semantic hits
  (today: 8 via fallback).
- A threshold inside the band (~0.78) → partial semantic filtering (new,
  previously untested).
- The expansion curve is reproduced by the new parameter:
  `expansion_floor: 0.93` keeps 0.9341 and cuts 0.9206–0.9272;
  `0.99` → zero expansion.
- Default calls (no `threshold`, no `expansion_floor`) → output unchanged;
  default fallback behaves as before.
- User `threshold` no longer affects block output.

## Out of scope (confirmed during brainstorm)

- Semantic ranking quality (note score is anti-discriminative on the report's
  data) → [[Retrieval eval harness]].
- Recalibrating the 0.5/0.35 defaults — they were never validated while the
  threshold was masked; with fallback-for-defaults their behavior does not
  change → eval harness.
- Short-token junk matching, `truncated` granularity, reranker — separate
  tasks.

## Open items carried into design

- Final parameter name (`expansion_floor` vs alternatives) — must fit the MCP
  parameter dictionary (ADR-0005: one concept = one name, renames cost a
  major).
- Shape of the fallback signal in `query_stats` (flag vs effective-threshold
  field) — scope item, small.
