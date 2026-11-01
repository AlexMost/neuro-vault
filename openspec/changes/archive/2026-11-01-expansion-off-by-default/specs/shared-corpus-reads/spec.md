## MODIFIED Requirements

### Requirement: The semantic leg is composed in the session and ranks as before

`search_notes`' semantic leg SHALL be composed in the session from `embed.query` and the corpus reads: per-query seeds with `limit + 1`, the fallback threshold for a query left empty under a default threshold, blocks within the seeds, and a best-block backfill for each seed left without blocks, all restricted by the search's `allowed` set. Expansion from each seed with the seeds excluded SHALL be composed only when the retrieval input asks for it, which no effort profile does. For the same corpus, queries, effort and overrides, it SHALL return the same seeds, similarities, blocks, related notes, `truncated`, `per_query_hits` and `per_query_fallback` as the in-memory composition it replaces. Every query of a search SHALL be sent in one corpus call per step.

#### Scenario: Parity with the in-memory leg

- **WHEN** the composed leg and the previous in-memory leg run over the same fixture corpus for `quick` and `deep`, with and without a filter, and once with expansion asked for explicitly
- **THEN** their outputs are identical

#### Scenario: One call per step for several queries

- **WHEN** `search_notes` runs three queries in `deep`
- **THEN** the seeds of all three come from one `corpus.nearest` call, and no further `nearest` call follows it
