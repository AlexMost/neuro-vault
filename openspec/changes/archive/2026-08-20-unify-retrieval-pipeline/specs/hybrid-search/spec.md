## ADDED Requirements

### Requirement: Semantic retrieval is arity-invariant

The semantic leg SHALL treat query arity as a surfacing concern, not a retrieval one: a single string `query` and a one-element array `query` SHALL produce identical `matches[]` — same notes, same order, same `similarity`, same `blocks[]`, same `expansion_similarity`, and the same top-level `truncated`. Every semantic-leg guarantee in this specification — mode defaults, the default-only fallback threshold, seed-scoped block selection, per-seed block backfill, and per-seed expansion — SHALL hold identically at both arities. The only permitted differences are the two response fields this specification already scopes to array queries: `matched_queries` on each match and the top-level `query_stats` object, both of which SHALL be absent for a single string `query` and present for an array `query` of any length, including one.

#### Scenario: a one-element array matches the equivalent string query

- **WHEN** `search_notes` is called with `{ query: "векторний пошук" }` and again with `{ query: ["векторний пошук"] }` against the same vault state
- **THEN** both responses carry the same `matches[]` in the same order with identical `similarity`, `blocks`, and `expansion_similarity` values, and the same `truncated`

#### Scenario: arity changes only which fields surface

- **WHEN** the two calls above are compared field by field
- **THEN** the array response additionally carries `query_stats` and a `matched_queries` array on each match, and the string response carries neither key — no other field differs

#### Scenario: the fallback threshold behaves identically at both arities

- **WHEN** a query returns zero semantic hits at its mode-default threshold, called once as a string and once as a one-element array
- **THEN** both calls retry at the 0.3 fallback threshold and return the same seeds, and the array call additionally reports `query_stats.<q>.semantic_fallback: true`

#### Scenario: leg-level pool truncation is reported identically at both arities

- **WHEN** the semantic leg's own pool cap drops candidates for a query issued once as a string and once as a one-element array
- **THEN** both responses report the same top-level `truncated` value
