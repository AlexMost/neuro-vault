## ADDED Requirements

### Requirement: Semantic seeds carry backfilled block evidence

The semantic leg SHALL guarantee per-seed block evidence after its shared block pass: every seed that ends the shared pass with zero blocks SHALL receive its own best block via a per-seed lookup scoped to that seed's source at threshold 0 with limit 1 (for an array `query`, the maximum-similarity block across all query vectors). Only when the note has no block embeddings at all SHALL the seed remain block-less, and its `matches[]` entry SHALL then omit the `blocks` key entirely.

#### Scenario: a seed starved by the shared block pass gets its own best block

- **WHEN** in `effort: "quick"` the global top-5 block pass assigns every block to other seeds, leaving a rank-2 semantic seed with zero blocks
- **THEN** that seed's `matches[]` entry carries `blocks[]` with at least one block — its own best block regardless of threshold

#### Scenario: a note without block embeddings omits the blocks key

- **WHEN** a semantic seed's note has a note-level embedding but no block embeddings
- **THEN** its `matches[]` entry carries `similarity` and no `blocks` key — not `blocks: []`

---

## MODIFIED Requirements

### Requirement: query_stats reports pre-cap per-query hit counts

For an array `query`, the response SHALL include `query_stats` mapping every normalized input query (trimmed, de-duplicated) to `{ semantic, lexical }` hit counts taken before cross-query merging and before any result-list cap. `semantic` SHALL be the number of notes that query retrieved from the semantic leg (post-threshold) when the leg executed, and SHALL be `null` — never `0` — when the semantic leg did not execute for the request (`mode: "lexical"`, no semantic corpus available, or the empty-filter early return); a numeric `semantic` SHALL always mean the leg ran and counted. `lexical` SHALL be the number of notes the query matched before the lexical note cap, counted over the leg's candidate set (`0` over an empty filter set). When the lexical leg executed and a query's `lexical` count is `0` while the query has two or more normalized tokens, its entry SHALL additionally carry `lexical_tokens` mapping each normalized token to the number of notes that token alone matches under the same normalization rules and filter set; `lexical_tokens` SHALL be omitted in every other case, including the empty-filter early return where neither leg runs. A query with zero hits in both executed legs SHALL report `{ semantic: 0, lexical: 0 }`. `query_stats` SHALL be omitted for a single string `query`.

#### Scenario: a dead query variant is visible in one line

- **WHEN** `search_notes` is called with `{ query: ["monetization research", "Мобі"] }` in hybrid mode with a corpus available and «Мобі» matches nothing in either leg
- **THEN** `query_stats["Мобі"]` is `{ semantic: 0, lexical: 0 }` while the other query reports non-zero counts

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

### Requirement: search_notes returns one RRF-ranked matches list

`search_notes` SHALL return `{ matches, truncated }` (plus `query_stats` for array queries) where `matches[]` is a single list ranked by reciprocal-rank fusion over three rank sources: the semantic leg's order, the lexical leg's order, and the flattened expansion order. Each entry SHALL carry `path`, `vault`, `backlink_count`, and provenance `found_in` — a non-empty array drawn from `"semantic"`, `"lexical:title"`, `"lexical:heading"`, `"lexical:body"`, `"expansion"` listing every source that surfaced the note (lexical kinds: every distinct `matched_in` present in the entry's capped `lexical[]` evidence). Per-source evidence SHALL accompany its provenance: `similarity` when `"semantic"` is present, `blocks[]` when `"semantic"` is present and the note has block-level evidence — `blocks[]` SHALL be non-empty whenever present and an empty `blocks` array SHALL never appear in a response — `lexical[]` (snippet matches) when any `"lexical:*"` value is present, `expansion_similarity` when `"expansion"` is present; evidence fields for absent sources SHALL be omitted. A note SHALL appear at most once in `matches[]`. An empty result SHALL be `matches: []`, never omitted. The response SHALL NOT contain `semantic_matches`, `lexical_matches`, or nested `related[]`.

#### Scenario: a two-source note carries both provenance and both evidence kinds

- **WHEN** a note with block embeddings is surfaced by both the semantic and lexical legs for `{ query: "retrieval" }`
- **THEN** `matches[]` contains one entry for it whose `found_in` includes `"semantic"` and a `"lexical:*"` value, with `similarity`, non-empty `blocks[]`, and `lexical[]` present

#### Scenario: expansion-only entry is provenance-complete but evidence-light

- **WHEN** a note enters the merged list only via expansion under `{ query: "x", effort: "deep" }`
- **THEN** its entry has `found_in: ["expansion"]`, `expansion_similarity`, `path`, `vault`, `backlink_count`, and no `similarity`, `blocks`, or `lexical` fields

#### Scenario: the old split keys are gone

- **WHEN** `search_notes` returns any response
- **THEN** the response contains no `semantic_matches`, `lexical_matches`, or `related` keys

#### Scenario: empty block arrays never ship

- **WHEN** `search_notes` returns any response in any mode
- **THEN** no `matches[]` entry contains `blocks: []`
