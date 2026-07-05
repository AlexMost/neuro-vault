# hybrid-search Specification

## Purpose
TBD - created by archiving change hybrid-search-notes. Update Purpose after archive.
## Requirements
### Requirement: search_notes returns a symmetric hybrid response

`search_notes` SHALL return `{ semantic_matches, lexical_matches }` in every
mode, plus top-level `truncated` when `query` is an array. `semantic_matches`
SHALL carry the previous semantic result tree unchanged (per-note
`similarity`, `blocks[]`, `related[]` and their invariants) — only the key
name changes from `results`. In `mode: "lexical"`, `semantic_matches` SHALL be
`[]`. An empty lexical result SHALL be `[]`, never omitted.

#### Scenario: hybrid response carries both legs

- **WHEN** `search_notes` is called with `{ query: "retrieval", mode: "hybrid" }`
- **THEN** the response contains both `semantic_matches` and `lexical_matches` arrays (either possibly empty), and no `results` key

#### Scenario: lexical mode returns an empty semantic leg

- **WHEN** `search_notes` is called with `{ query: "retrieval", mode: "lexical" }`
- **THEN** `semantic_matches` is `[]` and `lexical_matches` contains the lexical matches

### Requirement: Input axes mode and effort are orthogonal

The input schema SHALL expose `mode: "hybrid" | "lexical"` (default
`"hybrid"`) selecting which legs run, and `effort: "quick" | "deep"` (default
`"quick"`) selecting result volume (semantic: 3 vs 8 notes + `related[]`;
lexical: smaller vs larger default cap). The former depth values `"quick"`
and `"deep"` SHALL be rejected as `mode` values by schema validation with no
aliasing. `limit` SHALL bound the semantic tree in `mode: "hybrid"` and the
lexical note list in `mode: "lexical"`. `threshold` SHALL affect only the
semantic leg.

#### Scenario: old mode values are rejected

- **WHEN** `search_notes` is called with `{ query: "x", mode: "quick" }`
- **THEN** the call fails schema validation with an `INVALID_PARAMS`-class error naming the allowed values `"hybrid"` and `"lexical"`

#### Scenario: effort controls volume in hybrid mode

- **WHEN** `search_notes` is called with `{ query: "x", effort: "deep" }`
- **THEN** the semantic leg may return up to 8 notes with `related[]` and the lexical leg uses its larger default cap

#### Scenario: limit steers the lexical list in lexical mode

- **WHEN** `search_notes` is called with `{ query: "x", mode: "lexical", limit: 20 }`
- **THEN** `lexical_matches` contains at most 20 notes

### Requirement: Lexical leg matches title, headings, and body blocks

The lexical leg SHALL match against the note title (filename without `.md`),
markdown headings, and body content, where body units are block-level
markdown AST nodes with line positions. A multiword phrase split across
hard-wrapped source lines within one paragraph SHALL still match as a phrase.
Text inside fenced code blocks SHALL NOT be treated as headings. Frontmatter
SHALL be excluded from body matching.

#### Scenario: phrase matches across a hard-wrapped line break

- **WHEN** a note body contains `векторний\nпошук` inside one paragraph and the query is `векторний пошук`
- **THEN** the note appears in `lexical_matches` with a body match at that paragraph's line range

#### Scenario: heading inside a code fence is not a heading match

- **WHEN** a note's fenced code block contains the line `# пошук` and the query is `пошук`
- **THEN** any match for that block is reported with `matched_in: "body"`, not `matched_in: "heading"`

### Requirement: Lexical leg is independent of the embedding corpus

The lexical leg SHALL function with a cold, missing, or unreadable Smart
Connections corpus, and `mode: "lexical"` SHALL NOT invoke the corpus loader
at all. Semantic-leg failure or emptiness SHALL NOT fail the lexical leg.

#### Scenario: lexical search works without a corpus

- **WHEN** no Smart Connections corpus exists for the vault and `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** the call succeeds and `lexical_matches` contains title/heading/body matches

### Requirement: Matching is normalized substring AND

Matching SHALL be case- and accent-insensitive substring comparison over
normalized text: lowercase → NFKD → strip combining marks → apostrophe
unification (`'`, `ʼ`, `’`, `‘` fold to one form) → whitespace collapse. A
multi-token query SHALL match a unit only if every token is a substring of it
(AND); the whole normalized query as one contiguous substring SHALL rank as a
phrase match. Queries SHALL be tokenized on whitespace with punctuation
retained inside tokens.

#### Scenario: case and Cyrillic folding

- **WHEN** a note is titled `Пошук` and the query is `ПОШУК`
- **THEN** the note appears in `lexical_matches` with a title match

#### Scenario: apostrophe variants unify

- **WHEN** a note contains `об’єкт` (U+2019) and the query is `об'єкт` (U+0027)
- **THEN** the note appears in `lexical_matches`

#### Scenario: inflected forms match by substring

- **WHEN** a note heading contains `пошуком` and the query is `пошук`
- **THEN** the note appears in `lexical_matches` with a heading match

### Requirement: Lexical ranking is deterministic and tiered

Lexical results SHALL be ordered by six ordinal tiers — phrase-in-title,
tokens-in-title, phrase-in-heading, tokens-in-heading, phrase-in-body-block,
tokens-within-body-block — then within a tier by density (sum of matched
token lengths / unit length) descending, then `backlink_count` descending,
then `path` ascending. The full ordering SHALL be deterministic for a fixed
vault state. Lexical items SHALL NOT carry a numeric similarity/score field.
An implementation MAY evaluate tiers lazily with early exit once the global
cap is filled, provided the output is identical to full evaluation.

#### Scenario: title match outranks body match

- **WHEN** the query is `retrieval eval`, one note's title contains it and another note only mentions it in the body
- **THEN** the title-matching note precedes the body-matching note in `lexical_matches`

#### Scenario: density breaks ties within a tier

- **WHEN** the query is `пошук` and two notes match in title: `Пошук` and `Довгі роздуми про пошук сенсу`
- **THEN** `Пошук` precedes the longer title

#### Scenario: ordering is reproducible

- **WHEN** the same query runs twice against an unchanged vault
- **THEN** `lexical_matches` is byte-for-byte identical

### Requirement: Lexical results are grouped per note with capped evidence

Each `lexical_matches[]` item SHALL be
`{ path, backlink_count, vault, matched_queries?, matches: [...] }` where each
`matches[]` entry carries `matched_in: "title" | "heading" | "body"`, a
`snippet` (a bounded window around the first match, ellipsized, grapheme-safe),
`lines: [start, end]` for heading/body matches (from AST positions), and the
enclosing section `heading` for body matches. `matches` SHALL be capped per
note (~3) and the note list SHALL be capped globally by `effort` (or `limit`
in `mode: "lexical"`). A note SHALL appear at most once in `lexical_matches`.

#### Scenario: one note aggregates its matches

- **WHEN** a note matches the query in its title and in four body blocks
- **THEN** `lexical_matches` contains one item for that note whose `matches[]` holds the title match plus at most the top body matches within the per-note cap

#### Scenario: body match carries section context

- **WHEN** a body block under the heading `## Рішення` matches
- **THEN** its `matches[]` entry has `matched_in: "body"`, `lines`, and `heading` referencing that section

### Requirement: filter applies identically to both legs

`filter` SHALL constrain the lexical leg through the same pre-filtered path
set as the semantic leg — its `path_prefix`, `exclude_path_prefix`, `tags`,
and `frontmatter` fields bind both legs identically; a note excluded by
`filter` SHALL NOT appear in either leg.

#### Scenario: path filter constrains lexical matches

- **WHEN** `search_notes` is called with `{ query: "пошук", filter: { path_prefix: "Tasks/" } }`
- **THEN** every item in `lexical_matches` has a `path` starting with `Tasks/`

### Requirement: Multi-query and multi-vault keep their shapes

For an array `query`, lexical matches SHALL be computed per query, merged into
one ranked list, and annotated with `matched_queries` like the semantic leg;
top-level `truncated` SHALL reflect merged-candidate overflow. In multi-vault
mode without `vault`, fan-out SHALL wrap the hybrid response per vault in the
existing `results_by_vault` envelope.

#### Scenario: multi-query lexical merge

- **WHEN** `search_notes` is called with `{ query: ["векторний пошук", "vector search"], mode: "lexical" }`
- **THEN** each `lexical_matches` item carries `matched_queries` naming which queries hit it

#### Scenario: fan-out preserves the hybrid shape

- **WHEN** multiple vaults are registered and `search_notes` is called without `vault`
- **THEN** each per-vault entry in the fan-out envelope contains `{ semantic_matches, lexical_matches }`

### Requirement: Lexical corpus freshness without an index

Lexical matching SHALL reflect the vault state at request time: content is
re-read per request, with an mtime-keyed cache (`path → { mtime, title,
blocks }`) so only changed files are re-parsed. No persistent search index
SHALL be maintained.

#### Scenario: an edit is visible on the next call

- **WHEN** a note body gains the string `грибридний тест` and `search_notes` runs afterwards with that query
- **THEN** the note appears in `lexical_matches` without any server restart or reindex step

