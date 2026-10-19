## ADDED Requirements

### Requirement: Observability fields derive from leg outcomes
`semantic_status`, `query_stats` and `truncated` SHALL be derived from what the retrieval pipeline reports about each leg — whether it ran, was skipped or failed, its per-query counts, and whether its own pool cap dropped candidates — together with whether the merged cap cut the fused list and the backend status read once for the call. Every way a call can end (all legs ran, the semantic leg skipped or failed, a filter matching no notes) SHALL produce these fields from the same derivation, so that they cannot contradict each other or the `matches[]` they accompany. A semantic leg that failed and degraded to the lexical matches SHALL report as a leg that did not run: `semantic: null` in every `query_stats` entry and no `semantic_fallback` key.

#### Scenario: a semantic leg that fails mid-request reports null semantic counts

- **WHEN** `search_notes` is called with an array `query` against a `ready` backend and the semantic leg throws before returning hits
- **THEN** `semantic_status` is `unavailable` with its `note`, every `query_stats` entry has `semantic: null` and a numeric `lexical` count, and no entry carries `semantic_fallback`

#### Scenario: a filter matching no notes reads neither leg

- **WHEN** `search_notes` is called with a `filter` that matches no notes
- **THEN** no query is embedded and no lexical read is made, `matches[]` is empty, `truncated` is `false`, and `semantic_status` is the status read for the call

#### Scenario: any stage that dropped candidates sets truncated

- **WHEN** exactly one of the merged cap, the lexical leg's pool cap or the semantic leg's pool cap drops a candidate
- **THEN** `truncated` is `true`, and it is `false` when none of the three did
