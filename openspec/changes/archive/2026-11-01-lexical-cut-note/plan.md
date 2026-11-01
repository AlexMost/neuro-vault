# Lexical cut note Implementation Plan

Goal: per-variant guidance on `query_stats` when a variant's lexical matches were cut, and
`query_stats` on plain-string queries. TDD per task; gates after each.

## Task 1: `perQueryShown`

- Red: `retrieval-pipeline.test.ts` expects `perQueryShown: { quirkyterm: 2 }` on the ran record,
  and `{ quirkyterm: 1 }` for a lexical-only call with `cap: 1`.
- Green: after the merged-cap slice, count `c.lexical?.matchedQueries` per query, zero-filled
  for every input query.

## Task 2: observability

- Red: `search-observability.test.ts` — one entry for a string query; the cut-note cases of
  tasks.md 2.2.
- Green: drop the `isMulti` branch; add `hasFilter`; add `CUT_NOTE_CEILING` and the cut branch
  in `queryStatsNote` between the dead-variant and fallback branches.

## Task 3: contract

- Red: gate-level tests in `search-notes-e2e.test.ts`; arity test in
  `search-notes-hybrid.test.ts` expects equal `query_stats`.
- Green: output type, `hasFilter: input.filter !== undefined` at the call site, the description
  line (keep the 4,050 budget).

## Task 4: docs, verify, archive

- Update the guide and architecture docs; run all gates; review subagent; `verify.md`,
  `retrospective.md`; archive.
