## Context

`deriveObservability` (`search-observability.ts`) builds `truncated`, `semantic_status` and
`query_stats` from the pipeline's per-leg outcome records. It knows each variant's pre-cap
lexical count (`perQueryCounts`) but not how many of those notes survived the merged cap. The
pipeline's final candidates carry each note's lexical evidence with `matchedQueries`, so the
count is one pass over them.

## Goals / Non-Goals

**Goals:** a string query gets `query_stats`; a variant whose lexical matches were cut, and that
has at most 50 of them, carries a note naming N, k and the recovering call; nothing else gets a
new note.

**Non-Goals:** changing `truncated`; paging; a hint for the semantic leg; tuning the ceiling on
data (the agent-level check measures the note as a whole).

## Decisions

### D1: `perQueryShown` on the lexical leg's outcome

- **Choice:** `runRetrievalPipeline` counts, per query, the final candidates whose lexical
  evidence names it, and reports it as `perQueryShown` on the `ran` lexical record.
- **Rationale:** `deriveObservability` stays pure over records; the count is exact, not inferred
  from `truncated`.
- **Alternative:** pass the candidates into `deriveObservability`. Rejected: it would couple the
  observability module to the candidate shape for one number.

### D2: The condition is narrow

- **Choice:** the note fires when the lexical leg ran, `shown < lexical`, and
  `lexical <= CUT_NOTE_CEILING` (50).
- **Rationale:** the note must not become the new `truncated`. Broad variants (hundreds of
  matches) are not worth fetching in full, and a variant shown in full needs nothing.

### D3: Precedence and wording

- **Choice:** dead-variant notes, then the cut note, then the fallback note; one `note` per
  entry. The variant is quoted with `JSON.stringify`, so the suggested call is valid as written.
  A call with a filter gets `filter: <the same filter>` in the suggested call.
- **Rationale:** the cut note is the only one that recovers missing notes. Echoing the filter
  back would repeat a possibly large object; naming it is enough.

### D4: `query_stats` for string queries

- **Choice:** always present, one entry per normalized query. `matched_queries` stays
  array-only. The `isMulti` flag leaves `ObservabilityContext`; `hasFilter` joins it.
- **Rationale:** without an entry a string query has no total and no place for the note.

## Risks / Trade-offs

- A note on more responses costs context. Mitigated by D2; the agent-level check guards cost
  (large vault × Haiku cost per answer +10% at most).
- Agents may follow the note on a variant that is not the user's term. Accepted: N ≤ 50 bounds
  the cost of one extra call.
