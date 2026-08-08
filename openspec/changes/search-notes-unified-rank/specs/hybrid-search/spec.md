## ADDED Requirements

### Requirement: search_notes returns one RRF-ranked matches list

`search_notes` SHALL return `{ matches, truncated }` (plus `query_stats` for array queries) where `matches[]` is a single list ranked by reciprocal-rank fusion over three rank sources: the semantic leg's order, the lexical leg's order, and the flattened expansion order. Each entry SHALL carry `path`, `vault`, `backlink_count`, and provenance `found_in` — a non-empty array drawn from `"semantic"`, `"lexical:title"`, `"lexical:heading"`, `"lexical:body"`, `"expansion"` listing every source that surfaced the note (lexical kinds: every distinct `matched_in` present in the entry's capped `lexical[]` evidence). Per-source evidence SHALL accompany its provenance: `similarity` and `blocks[]` when `"semantic"` is present, `lexical[]` (snippet matches) when any `"lexical:*"` value is present, `expansion_similarity` when `"expansion"` is present; evidence fields for absent sources SHALL be omitted. A note SHALL appear at most once in `matches[]`. An empty result SHALL be `matches: []`, never omitted. The response SHALL NOT contain `semantic_matches`, `lexical_matches`, or nested `related[]`.

#### Scenario: a two-source note carries both provenance and both evidence kinds

- **WHEN** a note is surfaced by both the semantic and lexical legs for `{ query: "retrieval" }`
- **THEN** `matches[]` contains one entry for it whose `found_in` includes `"semantic"` and a `"lexical:*"` value, with both `similarity`/`blocks[]` and `lexical[]` present

#### Scenario: expansion-only entry is provenance-complete but evidence-light

- **WHEN** a note enters the merged list only via expansion under `{ query: "x", effort: "deep" }`
- **THEN** its entry has `found_in: ["expansion"]`, `expansion_similarity`, `path`, `vault`, `backlink_count`, and no `similarity`, `blocks`, or `lexical` fields

#### Scenario: the old split keys are gone

- **WHEN** `search_notes` returns any response
- **THEN** the response contains no `semantic_matches`, `lexical_matches`, or `related` keys

### Requirement: Rank fusion is reciprocal-rank with adaptive k

The merged order SHALL be computed as `score(note) = Σ_sources 1 / (k + rank)` with 1-based ranks, equal source weights, and `k = clamp(round(sqrt(N)), 5, 60)` where `N` is the vault's total note count independent of any `filter`. Ties SHALL break by source count descending, then `backlink_count` descending, then `path` ascending. The full ordering SHALL be deterministic for a fixed vault state. Fusion SHALL consume only source ranks — lexical entries SHALL NOT acquire a numeric score in the response.

#### Scenario: presence in two sources lifts a note over single-source top hits

- **WHEN** note A ranks first in the semantic leg only, and note B ranks mid-list in both the lexical leg and the expansion source
- **THEN** B's RRF score is the sum of two reciprocal ranks and B precedes A whenever that sum exceeds A's single reciprocal rank

#### Scenario: ordering is reproducible

- **WHEN** the same query runs twice against an unchanged vault
- **THEN** `matches[]` is byte-for-byte identical

### Requirement: Expansion is a flattened third rank source

Expansion candidates SHALL be collected across all seeds' neighbour sets, SHALL exclude paths already present as semantic results, and SHALL be deduplicated to unique paths keeping the maximum `expansion_similarity`, ordered by it. This flattened list SHALL be the third fusion source. In `effort: "quick"` (no expansion computed) the source SHALL be empty.

#### Scenario: a path repeated under several seeds fuses once at its best similarity

- **WHEN** the same path appears in two seeds' neighbour sets with expansion similarities 0.82 and 0.89
- **THEN** the expansion source contains that path once, ranked by 0.89, and its entry (if surfaced) carries `expansion_similarity: 0.89`

#### Scenario: semantic seeds do not compete against themselves

- **WHEN** a note is a semantic result and also appears in another seed's neighbour set
- **THEN** the expansion source excludes it and its entry's `found_in` does not contain `"expansion"`

### Requirement: query_stats reports pre-cap per-query hit counts

For an array `query`, the response SHALL include `query_stats` mapping every normalized input query (trimmed, de-duplicated) to `{ semantic, lexical }` hit counts taken before cross-query merging and before any result-list cap: `semantic` counts the notes that query retrieved from the semantic leg (post-threshold), `lexical` counts the notes it matched before the lexical note cap. A query with zero hits in both legs SHALL report `{ semantic: 0, lexical: 0 }`. `query_stats` SHALL be omitted for a single string `query`.

#### Scenario: a dead query variant is visible in one line

- **WHEN** `search_notes` is called with `{ query: ["monetization research", "Мобі"] }` and «Мобі» matches nothing in either leg
- **THEN** `query_stats["Мобі"]` is `{ semantic: 0, lexical: 0 }` while the other query reports non-zero counts

#### Scenario: merge-cap cuts do not zero a query's stats

- **WHEN** every note retrieved by query Q is dropped from `matches[]` by the merged-list cap
- **THEN** `query_stats[Q]` still reports Q's pre-cap hit counts

### Requirement: Single-source degradation preserves source order

In `mode: "lexical"`, or when no semantic corpus is available, the merge SHALL degrade to the lexical source alone: `matches[]` SHALL preserve the lexical ordering, every `found_in` SHALL contain only `lexical:*` values, and semantic evidence fields SHALL be absent. The corpus loader SHALL NOT be invoked in `mode: "lexical"`.

#### Scenario: lexical mode yields a purely lexical merged list

- **WHEN** `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** `matches[]` is ordered exactly as the lexical source and no entry carries `similarity`, `blocks`, or `expansion_similarity`

---

## MODIFIED Requirements

### Requirement: Input axes mode and effort are orthogonal

The input schema SHALL expose `mode: "hybrid" | "lexical"` (default `"hybrid"`) selecting which legs run, and `effort: "quick" | "deep"` (default `"quick"`) selecting candidate volume — the internal per-leg pools (semantic 3 vs 8 notes, lexical smaller vs larger cap, expansion only in `deep`) and the default merged-list cap (quick: 5, deep: 12). The former depth values `"quick"` and `"deep"` SHALL be rejected as `mode` values by schema validation with no aliasing. `limit` SHALL bound `matches[]` in every mode, overriding the effort default; internal per-leg pool caps SHALL NOT change with `limit`. `threshold` SHALL affect only the semantic leg. Top-level `truncated` SHALL be present in every response and true when candidates were dropped on the way to `matches[]` — by the merged-list cap or by the semantic or lexical leg's internal pool cap. Expansion per-seed neighbour caps are not surfaced (a literal signal there would be near-always true in deep mode).

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

## REMOVED Requirements

### Requirement: search_notes returns a symmetric hybrid response

**Reason**: The symmetric two-list shape (`semantic_matches` + `lexical_matches` + nested `related[]`) left rank fusion to the caller; the multi-source relevance signal the contract itself declared never materialized in result order. Replaced by the unified RRF-ranked `matches[]` (see ADDED requirements).

**Migration**: Consumers switch to `matches[]`: entry-level `found_in` replaces "which list is it in", `similarity`/`blocks[]` keep their meaning on semantic-sourced entries, per-note lexical evidence moves from `lexical_matches[].matches` to the entry's `lexical[]`, and nested `related[]` is gone — expansion-sourced entries appear directly in `matches[]` with `expansion_similarity`; use `get_similar_notes` for deliberate neighbour exploration. Breaking change, shipped as a major release.
