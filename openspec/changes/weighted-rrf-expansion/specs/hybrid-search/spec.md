## MODIFIED Requirements

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
