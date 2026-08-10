# hybrid-search delta — split-leg-thresholds

## ADDED Requirements

### Requirement: threshold is a hard semantic filter with default-only fallback

An explicitly provided `threshold` SHALL be a hard filter on the semantic leg's note scores: notes scoring below it SHALL NOT become semantic seeds, and when every note falls below it the semantic leg SHALL return zero hits — no retry, no rescue. Only when `threshold` is not provided SHALL the effort default apply (0.5 quick / 0.35 deep), and only then, on zero semantic hits, SHALL the leg retry once at the internal fallback threshold 0.3; the retry's engagement SHALL be observable via `query_stats` (see Requirement: query_stats reports pre-cap per-query hit counts). `threshold` SHALL NOT affect the expansion leg, the block-evidence pass, or the lexical leg.

#### Scenario: an explicit threshold above the hit band yields honest zero

- **WHEN** `search_notes` runs with `{ query: ["ретеншн алертів", "retention alerts"], effort: "deep", threshold: 0.99 }` against a corpus whose semantic hits score 0.7749–0.7964
- **THEN** no entry in `matches[]` carries `found_in: ["semantic"]` provenance and every `query_stats` entry reports `semantic: 0`

#### Scenario: an explicit threshold inside the hit band filters partially

- **WHEN** the semantic candidates for a query score between 0.7749 and 0.7964 and `threshold: 0.78` is passed explicitly
- **THEN** only notes scoring ≥ 0.78 appear with `"semantic"` provenance — more than zero and fewer than the unfiltered count

#### Scenario: default calls keep the fallback rescue

- **WHEN** `search_notes` runs without `threshold` and every note scores below the effort default but at least one scores ≥ 0.3
- **THEN** the semantic leg returns those notes via the fallback retry, exactly as before this change

### Requirement: expansion_floor bounds the expansion leg

The input schema SHALL expose `expansion_floor: number` (0–1, optional), subject to the same tolerant numeric coercion as `threshold`. The expansion leg SHALL discard neighbour candidates whose seed↔note similarity falls below `expansion_floor`; its default SHALL be 0.35, preserving the pre-change output of default calls byte-for-byte. `expansion_floor` SHALL be the only input that bounds expansion similarity — `threshold` SHALL NOT reach the expansion leg. In `effort: "quick"` and `mode: "lexical"` the parameter SHALL be accepted and inert, consistent with `threshold`'s behavior there.

#### Scenario: the calibration curve reproduces on the new parameter

- **WHEN** `search_notes` runs with `{ query: ["ретеншн алертів", "retention alerts"], effort: "deep", expansion_floor: 0.93 }` against a corpus whose expansion candidates score 0.9206, 0.9259, 0.9272, and 0.9341
- **THEN** every entry carrying `"expansion"` provenance has `expansion_similarity` ≥ 0.93, at least one such entry survives, and every neighbour whose maximum seed↔note similarity falls below 0.93 (across all seeds it appears under) is absent from the expansion source — lower-ranked seeds can see higher neighbour similarities than higher-ranked ones, so the exact surviving count varies with seed geometry rather than being fixed at one

#### Scenario: a floor above every candidate empties the expansion source

- **WHEN** the same query runs with `expansion_floor: 0.99`
- **THEN** no entry in `matches[]` carries `"expansion"` in `found_in`

#### Scenario: threshold no longer cuts expansion

- **WHEN** the same query runs with `{ threshold: 0.93 }` and no `expansion_floor`
- **THEN** the expansion source is not filtered at 0.93 — its content is determined solely by the default floor and the surviving semantic seeds

#### Scenario: default calls are unchanged

- **WHEN** any `search_notes` call omits both `threshold` and `expansion_floor` against a fixed vault state
- **THEN** the response is byte-for-byte identical to the pre-change output

## MODIFIED Requirements

### Requirement: Input axes mode and effort are orthogonal

The input schema SHALL expose `mode: "hybrid" | "lexical"` (default `"hybrid"`) selecting which legs run, and `effort: "quick" | "deep"` (default `"quick"`) selecting candidate volume — the internal per-leg pools (semantic 3 vs 8 notes, lexical smaller vs larger cap, expansion only in `deep`) and the default merged-list cap (quick: 5, deep: 12). The former depth values `"quick"` and `"deep"` SHALL be rejected as `mode` values by schema validation with no aliasing. `limit` SHALL bound `matches[]` in every mode, overriding the effort default; internal per-leg pool caps SHALL NOT change with `limit`. `threshold` SHALL affect only the semantic leg's note scores (see Requirement: threshold is a hard semantic filter with default-only fallback); `expansion_floor` SHALL affect only the expansion leg (see Requirement: expansion_floor bounds the expansion leg). Top-level `truncated` SHALL be present in every response and true when candidates were dropped on the way to `matches[]` — by the merged-list cap or by the semantic or lexical leg's internal pool cap. Expansion per-seed neighbour caps are not surfaced (a literal signal there would be near-always true in deep mode).

#### Scenario: old mode values are rejected

- **WHEN** `search_notes` is called with `{ query: "x", mode: "quick" }`
- **THEN** the call fails schema validation with an `INVALID_PARAMS`-class error naming the allowed values `"hybrid"` and `"lexical"`

#### Scenario: effort controls volume in hybrid mode

- **WHEN** `search_notes` is called with `{ query: "x", effort: "deep" }`
- **THEN** `matches[]` contains at most 12 entries drawn from the deep candidate pools, and expansion participates as a fusion source

#### Scenario: limit steers the lexical list in lexical mode

- **WHEN** `search_notes` is called with `{ query: "x", mode: "lexical", limit: 20 }`
- **THEN** `matches[]` contains at most 20 lexically-sourced entries

#### Scenario: limit caps the merged list in any mode

- **WHEN** `search_notes` is called with `{ query: "x", limit: 20 }`
- **THEN** `matches[]` contains at most 20 entries and `truncated` reports whether candidates were dropped

#### Scenario: leg-level truncation surfaces even when the merged cap is not hit

- **WHEN** a lexical-mode query matches more notes than the lexical leg's internal pool cap
- **THEN** `truncated` is true even though the merged list itself was not capped

### Requirement: Expansion is a flattened third rank source

Expansion candidates SHALL be collected across all seeds' neighbour sets with `expansion_floor` (default 0.35) as the similarity floor — the user `threshold` SHALL NOT participate — SHALL exclude paths already present as semantic results, and SHALL be deduplicated to unique paths keeping the maximum `expansion_similarity`, ordered by it. This flattened list SHALL be the third fusion source. In `effort: "quick"` (no expansion computed) the source SHALL be empty.

#### Scenario: a path repeated under several seeds fuses once at its best similarity

- **WHEN** the same path appears in two seeds' neighbour sets with expansion similarities 0.82 and 0.89
- **THEN** the expansion source contains that path once, ranked by 0.89, and its entry (if surfaced) carries `expansion_similarity: 0.89`

#### Scenario: semantic seeds do not compete against themselves

- **WHEN** a note is a semantic result and also appears in another seed's neighbour set
- **THEN** the expansion source excludes it and its entry's `found_in` does not contain `"expansion"`

#### Scenario: the floor, not the threshold, bounds neighbour similarity

- **WHEN** `effort: "deep"` runs with an explicit `threshold` and no `expansion_floor`
- **THEN** every seed's neighbour set is floored at the default `expansion_floor` (0.35) and the explicit `threshold` value has no effect on which neighbours survive

### Requirement: query_stats reports pre-cap per-query hit counts

For an array `query`, the response SHALL include `query_stats` mapping every normalized input query (trimmed, de-duplicated) to `{ semantic, lexical }` hit counts taken before cross-query merging and before any result-list cap. `semantic` SHALL be the number of notes that query retrieved from the semantic leg (post-threshold) when the leg executed, and SHALL be `null` — never `0` — when the semantic leg did not execute for the request (`mode: "lexical"`, no semantic corpus available, or the empty-filter early return); a numeric `semantic` SHALL always mean the leg ran and counted. When a query's semantic hits were produced by the default-threshold fallback retry at 0.3 (see Requirement: threshold is a hard semantic filter with default-only fallback), that query's entry SHALL additionally carry `semantic_fallback: true`; the key SHALL be absent in every other case, including explicit-threshold requests (where no fallback exists). `lexical` SHALL be the number of notes the query matched before the lexical note cap, counted over the leg's candidate set (`0` over an empty filter set). When the lexical leg executed and a query's `lexical` count is `0` while the query has two or more normalized tokens, its entry SHALL additionally carry `lexical_tokens` mapping each normalized token to the number of notes that token alone matches under the same normalization rules and filter set; `lexical_tokens` SHALL be omitted in every other case, including the empty-filter early return where neither leg runs. A query with zero hits in both executed legs SHALL report `{ semantic: 0, lexical: 0 }`. `query_stats` SHALL be omitted for a single string `query`.

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

#### Scenario: fallback-rescued hits are flagged per query

- **WHEN** `search_notes` runs with an array `query` and no `threshold`, and one query's notes all score below the effort default but above 0.3 while another query has hits above the default
- **THEN** the first query's `query_stats` entry carries `semantic_fallback: true` alongside its counts and the second query's entry has no `semantic_fallback` key

#### Scenario: explicit-threshold requests never carry the fallback flag

- **WHEN** `search_notes` runs with an array `query` and an explicit `threshold` that filters out every semantic hit
- **THEN** every `query_stats` entry reports `semantic: 0` with no `semantic_fallback` key

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

### Requirement: Semantic seeds carry backfilled block evidence

The semantic leg SHALL guarantee per-seed block evidence after its shared block pass, and that pass SHALL be independent of the user `threshold`: in `effort: "deep"` the shared pass filters blocks at the internal mode-default threshold (0.35), in `effort: "quick"` at threshold 0 — an explicitly provided `threshold` SHALL NOT change which blocks are selected. Every seed that ends the shared pass with zero blocks SHALL receive its own best block via a per-seed lookup scoped to that seed's source at threshold 0 with limit 1 (for an array `query`, the maximum-similarity block across all query vectors). Only when the note has no block embeddings at all SHALL the seed remain block-less, and its `matches[]` entry SHALL then omit the `blocks` key entirely.

#### Scenario: a seed starved by the shared block pass gets its own best block

- **WHEN** in `effort: "quick"` the global top-5 block pass assigns every block to other seeds, leaving a rank-2 semantic seed with zero blocks
- **THEN** that seed's `matches[]` entry carries `blocks[]` with at least one block — its own best block regardless of threshold

#### Scenario: a note without block embeddings omits the blocks key

- **WHEN** a semantic seed's note has a note-level embedding but no block embeddings
- **THEN** its `matches[]` entry carries `similarity` and no `blocks` key — not `blocks: []`

#### Scenario: an explicit threshold does not thin block evidence

- **WHEN** `effort: "deep"` runs with an explicit `threshold` inside the semantic note-score band, and a surviving seed's blocks score between 0.35 and that threshold
- **THEN** those blocks still appear in the seed's `blocks[]` — block selection used the internal 0.35 default, not the user threshold
