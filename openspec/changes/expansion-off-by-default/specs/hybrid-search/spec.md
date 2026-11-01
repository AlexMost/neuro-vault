## REMOVED Requirements

### Requirement: Expansion is a flattened third rank source

**Reason**: No effort runs the expansion leg any more. Measured through the production pipeline on two private golden sets (#270), notes that only this source surfaced were relevant 4 % and 1 % of the time; switching the source off raised list precision and cut the notes returned, with MRR unchanged and recall inside its confidence interval. Graph neighbours in place of embedding neighbours measured the same, so the source goes rather than its neighbour supply.

**Migration**: Callers that read `found_in: ["expansion"]` entries as "related notes" use `get_similar_notes` on a hit instead; the fused list keeps every semantic and lexical entry it carried before.

---

### Requirement: expansion_floor bounds the expansion leg

**Reason**: There is no expansion leg to bound. The parameter itself stays on the schema (see Requirement: expansion_floor is accepted and inert), because removing a parameter is a breaking change (ADR-0005).

**Migration**: Drop the parameter from calls; passing it is accepted and changes nothing.

---

### Requirement: search_notes returns one RRF-ranked matches list

**Reason**: Replaced by Requirement: search_notes returns one two-source RRF-ranked matches list, which drops the expansion source, its `"expansion"` provenance value and the `expansion_similarity` field; the scenario for an expansion-only entry has nothing left to describe.

**Migration**: Nothing for semantic and lexical entries, which keep their shape. An agent that treated `found_in: ["expansion"]` entries as leads calls `get_similar_notes` on a hit instead.

---

### Requirement: Rank fusion is reciprocal-rank with adaptive k

**Reason**: Replaced by Requirement: Rank fusion is two-source reciprocal-rank with adaptive k. The formula, `k` and the tie-break chain are unchanged; the expansion weight and the scenario about an equal-rank expansion candidate go with the source.

**Migration**: None for callers; the fused order over the semantic and lexical legs is computed as before.

---

## MODIFIED Requirements

### Requirement: Input axes mode and effort are orthogonal

The input schema SHALL expose `mode: "hybrid" | "lexical"` (default `"hybrid"`) selecting which legs run, and `effort: "quick" | "deep"` (default `"quick"`) selecting candidate volume — the internal per-leg pools (semantic 3 vs 8 notes, lexical smaller vs larger cap) and the default merged-list cap (quick: 5, deep: 12). No effort SHALL run an expansion leg. The former depth values `"quick"` and `"deep"` SHALL be rejected as `mode` values by schema validation with no aliasing. `limit` SHALL bound `matches[]` in every mode, overriding the effort default; internal per-leg pool caps SHALL NOT change with `limit`, except that when the lexical leg is the only source (`mode: "lexical"`, or no semantic leg to run) its pool SHALL equal `limit` (default: the effort's merged cap). `threshold` SHALL affect only the semantic leg's note scores (see Requirement: threshold is a hard semantic filter with default-only fallback); `expansion_floor` SHALL be accepted and inert (see Requirement: expansion_floor is accepted and inert). Top-level `truncated` SHALL be present in every response and true when candidates were dropped on the way to `matches[]` — by the merged-list cap or by the semantic or lexical leg's internal pool cap.

#### Scenario: old mode values are rejected

- **WHEN** `search_notes` is called with `{ query: "x", mode: "quick" }`
- **THEN** the call fails schema validation with an `INVALID_PARAMS`-class error naming the allowed values `"hybrid"` and `"lexical"`

#### Scenario: effort controls volume in hybrid mode

- **WHEN** `search_notes` is called with `{ query: "x", effort: "deep" }`
- **THEN** `matches[]` contains at most 12 entries drawn from the deep semantic and lexical pools, and no entry carries `"expansion"` in `found_in`

#### Scenario: limit steers the lexical list in lexical mode

- **WHEN** `search_notes` is called with `{ query: "x", mode: "lexical", limit: 20 }` and 14 notes match `x`
- **THEN** `matches[]` contains those 14 lexically-sourced entries and `truncated` is false
- **AND WHEN** more than 20 notes match `x`
- **THEN** `matches[]` contains exactly 20 entries and `truncated` is true

#### Scenario: limit caps the merged list in any mode

- **WHEN** `search_notes` is called with `{ query: "x", limit: 20 }`
- **THEN** `matches[]` contains at most 20 entries and `truncated` reports whether candidates were dropped

#### Scenario: leg-level truncation surfaces even when the merged cap is not hit

- **WHEN** a lexical-mode query matches more notes than the lexical leg's internal pool cap
- **THEN** `truncated` is true even though the merged list itself was not capped

---

### Requirement: threshold is a hard semantic filter with default-only fallback

An explicitly provided `threshold` SHALL be a hard filter on the semantic leg's note scores: notes scoring below it SHALL NOT become semantic seeds, and when every note falls below it the semantic leg SHALL return zero hits — no retry, no rescue. Only when `threshold` is not provided SHALL the active model profile's effort default apply (its `quick` or `deep` value), and only then, on zero semantic hits, SHALL the leg retry once at the profile's fallback threshold, provided the profile defines one. Under a profile that defines no fallback, a query with no note at or above the effort default SHALL get zero semantic hits. The retry's engagement SHALL be observable via `query_stats` (see Requirement: query_stats reports pre-cap per-query hit counts). `threshold` SHALL NOT affect the block-evidence pass or the lexical leg.

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

### Requirement: Single-source degradation preserves source order

In `mode: "lexical"`, or whenever the vault's semantic backend is not `ready` (indexing, disabled, or unavailable), the merge SHALL degrade to the lexical source alone: `matches[]` SHALL preserve the lexical ordering, every `found_in` SHALL contain only `lexical:*` values, and semantic evidence fields SHALL be absent. No corpus snapshot SHALL be read in `mode: "lexical"`.

#### Scenario: lexical mode yields a purely lexical merged list

- **WHEN** `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** `matches[]` is ordered exactly as the lexical source and no entry carries `similarity` or `blocks`

#### Scenario: a non-ready backend degrades the same way

- **WHEN** `search_notes` is called without `mode` against a vault whose backend is `indexing` or `disabled`
- **THEN** `matches[]` carries only `lexical:*` provenance and the response reports the corresponding `semantic_status`

---

### Requirement: Semantic retrieval is arity-invariant

The semantic leg SHALL treat query arity as a surfacing concern, not a retrieval one: a single string `query` and a one-element array `query` SHALL produce identical `matches[]` — same notes, same order, same `similarity`, same `blocks[]`, and the same top-level `truncated`. Every semantic-leg guarantee in this specification — mode defaults, the default-only fallback threshold, seed-scoped block selection, and per-seed block backfill — SHALL hold identically at both arities. The only permitted differences are the two response fields this specification already scopes to array queries: `matched_queries` on each match and the top-level `query_stats` object, both of which SHALL be absent for a single string `query` and present for an array `query` of any length, including one.

#### Scenario: a one-element array matches the equivalent string query

- **WHEN** `search_notes` is called with `{ query: "векторний пошук" }` and again with `{ query: ["векторний пошук"] }` against the same vault state
- **THEN** both responses carry the same `matches[]` in the same order with identical `similarity` and `blocks` values, and the same `truncated`

#### Scenario: arity changes only which fields surface

- **WHEN** the two calls above are compared field by field
- **THEN** the array response additionally carries `query_stats` and a `matched_queries` array on each match, and the string response carries neither key — no other field differs

#### Scenario: the fallback threshold behaves identically at both arities

- **WHEN** a query returns zero semantic hits at its mode-default threshold, called once as a string and once as a one-element array
- **THEN** both calls retry at the active profile's fallback threshold and return the same seeds, and the array call additionally reports `query_stats.<q>.semantic_fallback: true`

#### Scenario: leg-level pool truncation is reported identically at both arities

- **WHEN** the semantic leg's own pool cap drops candidates for a query issued once as a string and once as a one-element array
- **THEN** both responses report the same top-level `truncated` value

---

## ADDED Requirements

### Requirement: search_notes returns one two-source RRF-ranked matches list

`search_notes` SHALL return `{ matches, truncated }` (plus `query_stats` for array queries) where `matches[]` is a single list ranked by reciprocal-rank fusion over two rank sources: the semantic leg's order and the lexical leg's order. Each entry SHALL carry `path`, `vault`, `backlink_count`, and provenance `found_in` — a non-empty array drawn from `"semantic"`, `"lexical:title"`, `"lexical:heading"`, `"lexical:body"` listing every source that surfaced the note (lexical kinds: every distinct `matched_in` present in the entry's capped `lexical[]` evidence). Per-source evidence SHALL accompany its provenance: `similarity` when `"semantic"` is present, `blocks[]` when `"semantic"` is present and the note has block-level evidence — `blocks[]` SHALL be non-empty whenever present and an empty `blocks` array SHALL never appear in a response — `lexical[]` (snippet matches) when any `"lexical:*"` value is present; evidence fields for absent sources SHALL be omitted. No entry SHALL carry `"expansion"` provenance or an `expansion_similarity` field. A note SHALL appear at most once in `matches[]`. An empty result SHALL be `matches: []`, never omitted. The response SHALL NOT contain `semantic_matches`, `lexical_matches`, or nested `related[]`.

#### Scenario: a two-source note carries both provenance and both evidence kinds

- **WHEN** a note with block embeddings is surfaced by both the semantic and lexical legs for `{ query: "retrieval" }`
- **THEN** `matches[]` contains one entry for it whose `found_in` includes `"semantic"` and a `"lexical:*"` value, with `similarity`, non-empty `blocks[]`, and `lexical[]` present

#### Scenario: a neighbour of a seed does not enter the list on its own

- **WHEN** `search_notes` runs with `{ query: "x", effort: "deep" }` and a note lies within the active profile's `expansionFloor` of a semantic seed while scoring below the semantic floor for the query and matching it lexically nowhere
- **THEN** that note is absent from `matches[]`, and no entry carries `"expansion"` in `found_in` or an `expansion_similarity` field

#### Scenario: the old split keys are gone

- **WHEN** `search_notes` returns any response
- **THEN** the response contains no `semantic_matches`, `lexical_matches`, or `related` keys

#### Scenario: empty block arrays never ship

- **WHEN** `search_notes` returns any response in any mode
- **THEN** no `matches[]` entry contains `blocks: []`

---

### Requirement: Rank fusion is two-source reciprocal-rank with adaptive k

The merged order SHALL be computed as `score(note) = Σ_sources w_source / (k + rank)` with 1-based ranks and `k = clamp(round(sqrt(N)), 5, 60)` where `N` is the vault's total note count independent of any `filter`. The semantic and lexical sources SHALL contribute at weight 1, and no other source SHALL contribute. Ties SHALL break by source count descending, then `path` ascending; `backlink_count` SHALL NOT participate in fusion ordering (it remains a per-entry response field). The full ordering SHALL be deterministic for a fixed vault state. Fusion SHALL consume only source ranks — lexical entries SHALL NOT acquire a numeric score in the response.

#### Scenario: presence in two sources lifts a note over single-source top hits

- **WHEN** note A ranks first in the semantic leg only, and note B ranks mid-list in both the semantic and lexical legs
- **THEN** B's RRF score is the sum of its two reciprocal ranks and B precedes A whenever that sum exceeds A's single reciprocal rank

#### Scenario: ordering is reproducible

- **WHEN** the same query runs twice against an unchanged vault
- **THEN** `matches[]` is byte-for-byte identical

#### Scenario: backlinks do not decide residual ties

- **WHEN** two notes tie exactly on fused score and source count while their backlink counts differ
- **THEN** their relative order is by `path` ascending, unaffected by either note's `backlink_count`

---

### Requirement: expansion_floor is accepted and inert

The input schema SHALL expose `expansion_floor: number` (0–1, optional), subject to the same tolerant numeric coercion as `threshold`, for compatibility with callers that pass it. It SHALL be inert at every effort and in every mode: no expansion leg runs, so it bounds nothing, and a call that passes it SHALL return the same `matches[]` as the same call without it. Its schema description SHALL say that it has no effect and that it is removed at the next major version, and SHALL NOT state a numeric default. Removing the parameter SHALL be a breaking change (ADR-0005).

#### Scenario: the parameter is advertised with coercion and bounds

- **WHEN** the registered tool's `inputSchema` is inspected
- **THEN** it accepts `expansion_floor: 0.93` and `expansion_floor: "0.93"`, rejects `1.5` and `-0.1`, and the field's description says the value has no effect and names its removal, quoting no default

#### Scenario: the parameter changes nothing at deep effort

- **WHEN** `search_notes` runs with `{ query: "x", effort: "deep", expansion_floor: 0.9 }` and with `{ query: "x", effort: "deep" }` against the same vault state
- **THEN** both responses carry the same `matches[]`, and no entry carries `"expansion"` in `found_in`

#### Scenario: the parameter is accepted in lexical mode and at quick effort

- **WHEN** `search_notes` runs with `{ query: "x", mode: "lexical", expansion_floor: 0.9 }` and with `{ query: "x", effort: "quick", expansion_floor: 0.9 }`
- **THEN** both calls succeed and return the matches the same calls return without the parameter
