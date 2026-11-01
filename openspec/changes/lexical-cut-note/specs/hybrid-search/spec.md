## MODIFIED Requirements

### Requirement: query_stats reports pre-cap per-query hit counts

The response SHALL include `query_stats` mapping every normalized input query (trimmed, de-duplicated; a single string `query` is one entry keyed by its normalized form) to `{ semantic, lexical }` hit counts taken before cross-query merging and before any result-list cap. `semantic` SHALL be the number of notes that query retrieved from the semantic leg (post-threshold) when the leg executed, and SHALL be `null` — never `0` — when the semantic leg did not execute for the request (`mode: "lexical"`, no semantic corpus available, or the empty-filter early return); a numeric `semantic` SHALL always mean the leg ran and counted. When a query's semantic hits were produced by the default-threshold fallback retry at the active profile's fallback threshold (see Requirement: threshold is a hard semantic filter with default-only fallback), that query's entry SHALL additionally carry `semantic_fallback: true`; the key SHALL be absent in every other case, including explicit-threshold requests (where no fallback exists). `lexical` SHALL be the number of notes the query matched before the lexical note cap, counted over the leg's candidate set (`0` over an empty filter set). When the lexical leg executed and a query's `lexical` count is `0` while the query has two or more normalized tokens, its entry SHALL additionally carry `lexical_tokens` mapping each normalized token to the number of notes that token alone matches under the same normalization rules and filter set; `lexical_tokens` SHALL be omitted in every other case, including the empty-filter early return where neither leg runs. A query with zero hits in both executed legs SHALL report `{ semantic: 0, lexical: 0 }`.

An entry SHALL additionally carry `note` — one sentence naming what to do about it — exactly when at least one leg executed and the entry is worth acting on, so that the tool description does not have to teach how to read these numbers. `note` SHALL diagnose, in this order of precedence: a variant with no hits in any executed leg names the tokens whose zero killed the AND match when `lexical_tokens` identifies them, tells the caller to split the variant into separate array entries when every token matches alone but never co-occurs, and otherwise says to rephrase or drop the variant; failing that, a variant whose lexical matches were cut — fewer of the notes it matched lexically reached `matches[]` than its `lexical` count N, with N at most 50 — SHALL name N, the number shown, and the call that returns all of them, `search_notes({ query: <the variant>, mode: "lexical", limit: N })`, telling the caller to keep the same filter when the call had one; failing that, an entry carrying `semantic_fallback` SHALL say its semantic hits are weaker for having come from the retry. `note` SHALL be absent when neither leg executed — a zero on the empty-filter early return describes the filter, not the query, and SHALL NOT be diagnosed as a dead variant.

#### Scenario: a dead query variant is visible in one line

- **WHEN** `search_notes` is called with `{ query: ["monetization research", "Мобі"] }` in hybrid mode with a corpus available and «Мобі» matches nothing in either leg
- **THEN** `query_stats["Мобі"]` is `{ semantic: 0, lexical: 0 }` with a `note` telling the caller to rephrase or drop it, while the other query reports non-zero counts and no `note`

#### Scenario: a plain string query reports its stats

- **WHEN** `search_notes` is called with `{ query: "трейдинг", mode: "lexical" }`
- **THEN** `query_stats` has exactly one entry, keyed `трейдинг`, with `semantic: null` and its numeric `lexical` count

#### Scenario: a cut variant names the call that returns all of its matches

- **WHEN** `search_notes` is called with `{ query: "трейдинг", mode: "lexical" }` and 14 notes match, of which the quick cap shows 5
- **THEN** `query_stats["трейдинг"].note` says it matched 14 notes lexically, 5 shown, and names `search_notes({ query: "трейдинг", mode: "lexical", limit: 14 })`, which returns all 14 with no note

#### Scenario: a variant shown in full carries no cut note

- **WHEN** every note a variant matched lexically is in `matches[]`
- **THEN** its `query_stats` entry carries no cut note

#### Scenario: a broad variant carries no cut note

- **WHEN** a variant matched more than 50 notes lexically and only some are shown
- **THEN** its `query_stats` entry carries no `note`

#### Scenario: the killer token is named, not left to be inferred

- **WHEN** a multi-token query returns `lexical: 0` and one of its `lexical_tokens` counts is `0`
- **THEN** the entry's `note` names that token and says to drop or replace it

#### Scenario: co-occurrence failure is diagnosed as a split, not a rephrase

- **WHEN** a multi-token query returns `lexical: 0` and every one of its `lexical_tokens` counts is above `0`
- **THEN** the entry's `note` tells the caller to split the variant into separate array entries

#### Scenario: an untried query is not called dead

- **WHEN** a `filter` matches no notes, neither leg runs, and `query_stats` reports `{ semantic: null, lexical: 0 }` per query
- **THEN** no entry carries a `note`, because the zero describes the filter rather than the query

#### Scenario: merge-cap cuts do not zero a query's stats

- **WHEN** every note retrieved by query Q is dropped from `matches[]` by the merged-list cap
- **THEN** `query_stats[Q]` still reports Q's pre-cap hit counts

#### Scenario: a leg that never ran reports null, not zero

- **WHEN** `search_notes` is called with `{ query: ["пошук", "search"], mode: "lexical" }`
- **THEN** every `query_stats` entry has `semantic: null` and a numeric `lexical` count

#### Scenario: no corpus reports null semantic counts

- **WHEN** no semantic corpus is available for the vault and `search_notes` is called with an array `query` in default hybrid mode
- **THEN** every `query_stats` entry has `semantic: null`

#### Scenario: an AND-killed multi-token query names the killer token

- **WHEN** `search_notes` is called with `{ query: ["ретеншн алертів"], mode: "lexical" }` against a vault where «алертів» matches notes but «ретеншн» matches none
- **THEN** `query_stats["ретеншн алертів"]` has `lexical: 0` and `lexical_tokens` with a zero count for «ретеншн» and a non-zero count for «алертів»

#### Scenario: single-token dead queries carry no token diagnostic

- **WHEN** an array-query entry with one normalized token reports `lexical: 0`
- **THEN** its `query_stats` entry has no `lexical_tokens` key

#### Scenario: matching queries carry no token diagnostic

- **WHEN** an array-query entry with two or more tokens reports a non-zero `lexical` count
- **THEN** its `query_stats` entry has no `lexical_tokens` key

#### Scenario: empty-filter early return carries no token diagnostic

- **WHEN** `filter` matches zero notes and `search_notes` is called with a multi-token array query
- **THEN** each `query_stats` entry is `{ semantic: null, lexical: 0 }` with no `lexical_tokens` key
#### Scenario: fallback-rescued hits are flagged per query

- **WHEN** `search_notes` runs with an array `query` and no `threshold`, and one query's notes all score below the profile's effort default but at or above its fallback threshold while another query has hits above the default
- **THEN** the first query's `query_stats` entry carries `semantic_fallback: true` alongside its counts and the second query's entry has no `semantic_fallback` key

#### Scenario: explicit-threshold requests never carry the fallback flag

- **WHEN** `search_notes` runs with an array `query` and an explicit `threshold` that filters out every semantic hit
- **THEN** every `query_stats` entry reports `semantic: 0` with no `semantic_fallback` key

### Requirement: Semantic retrieval is arity-invariant

The semantic leg SHALL treat query arity as a surfacing concern, not a retrieval one: a single string `query` and a one-element array `query` SHALL produce identical `matches[]` — same notes, same order, same `similarity`, same `blocks[]`, same `expansion_similarity`, and the same top-level `truncated`. Every semantic-leg guarantee in this specification — mode defaults, the default-only fallback threshold, seed-scoped block selection, per-seed block backfill, and per-seed expansion — SHALL hold identically at both arities. The only permitted difference is the response field this specification scopes to array queries: `matched_queries` on each match, which SHALL be absent for a single string `query` and present for an array `query` of any length, including one. The top-level `query_stats` object SHALL be present, and identical, at both arities.

#### Scenario: a one-element array matches the equivalent string query

- **WHEN** `search_notes` is called with `{ query: "векторний пошук" }` and again with `{ query: ["векторний пошук"] }` against the same vault state
- **THEN** both responses carry the same `matches[]` in the same order with identical `similarity`, `blocks`, and `expansion_similarity` values, and the same `truncated`

#### Scenario: arity changes only which fields surface

- **WHEN** the two calls above are compared field by field
- **THEN** the array response additionally carries a `matched_queries` array on each match, the string response does not, and both carry the same `query_stats` — no other field differs

#### Scenario: the fallback threshold behaves identically at both arities

- **WHEN** a query returns zero semantic hits at its mode-default threshold, called once as a string and once as a one-element array
- **THEN** both calls retry at the active profile's fallback threshold and return the same seeds, and both report `query_stats.<q>.semantic_fallback: true`

#### Scenario: leg-level pool truncation is reported identically at both arities

- **WHEN** the semantic leg's own pool cap drops candidates for a query issued once as a string and once as a one-element array
- **THEN** both responses report the same top-level `truncated` value
