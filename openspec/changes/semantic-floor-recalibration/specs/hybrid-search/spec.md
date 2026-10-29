## MODIFIED Requirements

### Requirement: threshold is a hard semantic filter with default-only fallback

An explicitly provided `threshold` SHALL be a hard filter on the semantic leg's note scores: notes scoring below it SHALL NOT become semantic seeds, and when every note falls below it the semantic leg SHALL return zero hits — no retry, no rescue. Only when `threshold` is not provided SHALL the active model profile's effort default apply (its `quick` or `deep` value), and only then, on zero semantic hits, SHALL the leg retry once at the profile's fallback threshold, provided the profile defines one. Under a profile that defines no fallback, a query with no note at or above the effort default SHALL get zero semantic hits. The retry's engagement SHALL be observable via `query_stats` (see Requirement: query_stats reports pre-cap per-query hit counts). `threshold` SHALL NOT affect the expansion leg, the block-evidence pass, or the lexical leg.

#### Scenario: an explicit threshold above the hit band yields honest zero

- **WHEN** `search_notes` runs with `{ query: ["ретеншн алертів", "retention alerts"], effort: "deep", threshold: 0.99 }` against a corpus whose semantic hits score 0.7749–0.7964
- **THEN** no entry in `matches[]` carries `found_in: ["semantic"]` provenance and every `query_stats` entry reports `semantic: 0`

#### Scenario: an explicit threshold inside the hit band filters partially

- **WHEN** the semantic candidates for a query score between 0.7749 and 0.7964 and `threshold: 0.78` is passed explicitly
- **THEN** only notes scoring ≥ 0.78 appear with `"semantic"` provenance — more than zero and fewer than the unfiltered count

#### Scenario: default calls keep the fallback rescue

- **WHEN** `search_notes` runs without `threshold` under a profile that defines a fallback, and every note scores below the profile's effort default but at least one scores at or above the profile's fallback threshold
- **THEN** the semantic leg returns those notes via the fallback retry

#### Scenario: a profile without a fallback returns an honest zero

- **WHEN** `search_notes` runs with an array `query` and no `threshold` under a profile that defines no fallback, and every note scores below the profile's effort default for one query
- **THEN** that query's `query_stats` entry reports `semantic: 0` with no `semantic_fallback` key, and no retry read is made

---

### Requirement: Semantic seeds carry backfilled block evidence

The semantic leg SHALL guarantee per-seed block evidence after its shared block pass, and that pass SHALL be independent of the user `threshold` and of the effort's note floor: in `effort: "deep"` the shared pass filters blocks at the active profile's block-evidence floor, in `effort: "quick"` at threshold 0 — an explicitly provided `threshold` SHALL NOT change which blocks are selected. Every seed that ends the shared pass with zero blocks SHALL receive its own best block via a per-seed lookup scoped to that seed's source at threshold 0 with limit 1 (for an array `query`, the maximum-similarity block across all query vectors). Only when the note has no block embeddings at all SHALL the seed remain block-less, and its `matches[]` entry SHALL then omit the `blocks` key entirely.

#### Scenario: a seed starved by the shared block pass gets its own best block

- **WHEN** in `effort: "quick"` the global top-5 block pass assigns every block to other seeds, leaving a rank-2 semantic seed with zero blocks
- **THEN** that seed's `matches[]` entry carries `blocks[]` with at least one block — its own best block regardless of threshold

#### Scenario: a note without block embeddings omits the blocks key

- **WHEN** a semantic seed's note has a note-level embedding but no block embeddings
- **THEN** its `matches[]` entry carries `similarity` and no `blocks` key — not `blocks: []`

#### Scenario: an explicit threshold does not thin block evidence

- **WHEN** `effort: "deep"` runs with an explicit `threshold` inside the semantic note-score band, and a surviving seed's blocks score between the profile's block-evidence floor and that threshold
- **THEN** those blocks still appear in the seed's `blocks[]` — block selection used the profile's block-evidence floor, not the user threshold

#### Scenario: a raised note floor does not thin block evidence

- **WHEN** `effort: "deep"` runs without `threshold` under a profile whose `deep` default is above its block-evidence floor, and a seed's blocks score between the two
- **THEN** those blocks appear in the seed's `blocks[]`
