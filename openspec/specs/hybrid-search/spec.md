# hybrid-search Specification

## Purpose
TBD - created by archiving change hybrid-search-notes. Update Purpose after archive.
## Requirements
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

### Requirement: Lexical leg matches title, headings, and body blocks

The lexical leg SHALL match against the note title (filename without `.md`), markdown headings, and body content, where body units are block-level markdown AST nodes with line positions. A multiword phrase split across hard-wrapped source lines within one paragraph SHALL still match as a phrase. Text inside fenced code blocks SHALL NOT be treated as headings. Frontmatter SHALL be excluded from body matching.

#### Scenario: phrase matches across a hard-wrapped line break

- **WHEN** a note body contains `векторний\nпошук` inside one paragraph and the query is `векторний пошук`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:body"` and a `lexical[]` entry at that paragraph's line range

#### Scenario: heading inside a code fence is not a heading match

- **WHEN** a note's fenced code block contains the line `# пошук` and the query is `пошук`
- **THEN** any match for that block is reported with `matched_in: "body"`, not `matched_in: "heading"`

### Requirement: Lexical leg is independent of the embedding corpus

The lexical leg SHALL function with a cold, missing, or unreadable Smart Connections corpus, and `mode: "lexical"` SHALL NOT invoke the corpus loader at all. Semantic-leg failure or emptiness SHALL NOT fail the lexical leg.

#### Scenario: lexical search works without a corpus

- **WHEN** no Smart Connections corpus exists for the vault and `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** the call succeeds and `matches[]` contains lexically-sourced entries with title/heading/body evidence

### Requirement: Matching is normalized substring AND

Matching SHALL be case- and accent-insensitive substring comparison over normalized text: lowercase → NFKD → strip combining marks → apostrophe unification (`'`, `ʼ`, `’`, `‘` fold to one form) → whitespace collapse. A multi-token query SHALL match a unit only if every token is a substring of it (AND); the whole normalized query as one contiguous substring SHALL rank as a phrase match. Queries SHALL be tokenized on whitespace with punctuation retained inside tokens.

#### Scenario: case and Cyrillic folding

- **WHEN** a note is titled `Пошук` and the query is `ПОШУК`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:title"`

#### Scenario: apostrophe variants unify

- **WHEN** a note contains `об’єкт` (U+2019) and the query is `об'єкт` (U+0027)
- **THEN** the note appears in `matches[]` with lexical provenance

#### Scenario: inflected forms match by substring

- **WHEN** a note heading contains `пошуком` and the query is `пошук`
- **THEN** the note appears in `matches[]` with `found_in` containing `"lexical:heading"`

### Requirement: Lexical ranking is deterministic and tiered

The lexical rank source SHALL order its candidates by six ordinal tiers — phrase-in-title, tokens-in-title, phrase-in-heading, tokens-in-heading, phrase-in-body-block, tokens-within-body-block — then within a tier by density (sum of matched token lengths / unit length) descending, then `backlink_count` descending, then `path` ascending. This ordering SHALL be deterministic for a fixed vault state and SHALL be the rank the fusion consumes for the lexical source. Lexically-sourced entries SHALL NOT carry a numeric lexical score field. An implementation MAY evaluate tiers lazily with early exit once the lexical cap is filled, provided the output is identical to full evaluation.

#### Scenario: title match outranks body match

- **WHEN** the query is `retrieval eval` in `mode: "lexical"`, one note's title contains it and another note only mentions it in the body
- **THEN** the title-matching note precedes the body-matching note in `matches[]`

#### Scenario: density breaks ties within a tier

- **WHEN** the query is `пошук` in `mode: "lexical"` and two notes match in title: `Пошук` and `Довгі роздуми про пошук сенсу`
- **THEN** `Пошук` precedes the longer title in `matches[]`

#### Scenario: ordering is reproducible

- **WHEN** the same query runs twice in `mode: "lexical"` against an unchanged vault
- **THEN** `matches[]` is byte-for-byte identical

### Requirement: Lexical results are grouped per note with capped evidence

Lexical evidence SHALL be grouped per note on its `matches[]` entry as `lexical: [...]`, where each item carries `matched_in: "title" | "heading" | "body"`, a `snippet` (a bounded window around the first match, ellipsized, grapheme-safe), `lines: [start, end]` for heading/body matches (from AST positions), and the enclosing section `heading` for body matches. `lexical` SHALL be capped per note (~3) and SHALL be present exactly on entries whose `found_in` contains a `lexical:*` value.

#### Scenario: one note aggregates its matches

- **WHEN** a note matches the query in its title and in four body blocks
- **THEN** `matches[]` contains one entry for that note whose `lexical[]` holds the title match plus at most the top body matches within the per-note cap

#### Scenario: body match carries section context

- **WHEN** a body block under the heading `## Рішення` matches
- **THEN** its `lexical[]` item has `matched_in: "body"`, `lines`, and `heading` referencing that section

### Requirement: filter applies identically to both legs

`filter` SHALL constrain the lexical leg through the same pre-filtered path set as the semantic leg — its `path_prefix`, `exclude_path_prefix`, `tags`, and `frontmatter` fields bind both legs identically; a note excluded by `filter` SHALL NOT appear in any fusion source or in `matches[]`.

#### Scenario: path filter constrains lexical matches

- **WHEN** `search_notes` is called with `{ query: "пошук", filter: { path_prefix: "Tasks/" } }`
- **THEN** every entry in `matches[]` has a `path` starting with `Tasks/`

### Requirement: Multi-query and multi-vault keep their shapes

For an array `query`, each leg SHALL compute per-query results and merge them into its single source ranking before fusion; entries SHALL carry `matched_queries` as the union of queries that hit the note in any leg. Top-level `truncated` SHALL reflect candidate overflow from the merged cap or the semantic or lexical leg's pool cap, and `query_stats` SHALL accompany the response. In multi-vault mode without `vault`, fan-out SHALL wrap the unified response per vault in the existing `results_by_vault` envelope, with fusion computed independently per vault.

#### Scenario: multi-query lexical merge

- **WHEN** `search_notes` is called with `{ query: ["векторний пошук", "vector search"], mode: "lexical" }`
- **THEN** each entry in `matches[]` carries `matched_queries` naming which queries hit it

#### Scenario: matched_queries unions across legs

- **WHEN** `search_notes` is called with `{ query: ["векторний пошук", "vector search"] }` and a note is hit by the first query lexically and the second semantically
- **THEN** that note's entry carries both queries in `matched_queries`

#### Scenario: fan-out preserves the hybrid shape

- **WHEN** multiple vaults are registered and `search_notes` is called without `vault`
- **THEN** each per-vault entry in the fan-out envelope contains `{ matches, truncated }` fused from that vault's own sources

### Requirement: Lexical corpus freshness without an index

Lexical matching SHALL reflect the vault state at request time: content is re-read per request, with an mtime-keyed cache (`path → { mtime, title, blocks }`) so only changed files are re-parsed. No persistent search index SHALL be maintained.

#### Scenario: an edit is visible on the next call

- **WHEN** a note body gains the string `грибридний тест` and `search_notes` runs afterwards with that query
- **THEN** the note appears in `matches[]` with lexical provenance, without any server restart or reindex step

---

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

### Requirement: Rank fusion is reciprocal-rank with adaptive k

The merged order SHALL be computed as `score(note) = Σ_sources w_source / (k + rank)` with 1-based ranks and `k = clamp(round(sqrt(N)), 5, 60)` where `N` is the vault's total note count independent of any `filter`. The semantic and lexical sources SHALL contribute at weight 1; the expansion source SHALL contribute at weight `w_expansion` — a fusion parameter with default `0.85`, not exposed on the tool's input schema. Ties SHALL break by source count descending, then `path` ascending; `backlink_count` SHALL NOT participate in fusion ordering (it remains a per-entry response field). The full ordering SHALL be deterministic for a fixed vault state. Fusion SHALL consume only source ranks — lexical entries SHALL NOT acquire a numeric score in the response.

#### Scenario: presence in two sources lifts a note over single-source top hits

- **WHEN** note A ranks first in the semantic leg only, and note B ranks mid-list in both the lexical leg and the expansion source
- **THEN** B's RRF score is the weighted sum of its two reciprocal ranks and B precedes A whenever that sum exceeds A's single reciprocal rank

#### Scenario: ordering is reproducible

- **WHEN** the same query runs twice against an unchanged vault
- **THEN** `matches[]` is byte-for-byte identical

#### Scenario: an equal-rank expansion candidate does not outrank a primary hit

- **WHEN** the lexical leg is empty and a semantic result and an expansion candidate hold the same rank in their respective sources, the expansion candidate having a higher `backlink_count`
- **THEN** the semantic result precedes the expansion candidate in `matches[]` at every rank, because the expansion contribution is down-weighted and backlinks no longer arbitrate

#### Scenario: backlinks do not decide residual ties

- **WHEN** two notes tie exactly on fused score and source count while their backlink counts differ
- **THEN** their relative order is by `path` ascending, unaffected by either note's `backlink_count`

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

- **WHEN** `search_notes` runs with an array `query` and no `threshold`, and one query's notes all score below the effort default but above 0.3 while another query has hits above the default
- **THEN** the first query's `query_stats` entry carries `semantic_fallback: true` alongside its counts and the second query's entry has no `semantic_fallback` key

#### Scenario: explicit-threshold requests never carry the fallback flag

- **WHEN** `search_notes` runs with an array `query` and an explicit `threshold` that filters out every semantic hit
- **THEN** every `query_stats` entry reports `semantic: 0` with no `semantic_fallback` key

### Requirement: Single-source degradation preserves source order

In `mode: "lexical"`, or when no semantic corpus is available, the merge SHALL degrade to the lexical source alone: `matches[]` SHALL preserve the lexical ordering, every `found_in` SHALL contain only `lexical:*` values, and semantic evidence fields SHALL be absent. The corpus loader SHALL NOT be invoked in `mode: "lexical"`.

#### Scenario: lexical mode yields a purely lexical merged list

- **WHEN** `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** `matches[]` is ordered exactly as the lexical source and no entry carries `similarity`, `blocks`, or `expansion_similarity`

---

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

---

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

