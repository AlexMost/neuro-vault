## MODIFIED Requirements

### Requirement: search_notes reports the vault's semantic index state

Every per-vault `search_notes` payload SHALL carry `semantic_status: { state, indexed?, total?, note? }`, where `state` is one of `ready`, `indexing`, `disabled`, or `unavailable`, and `indexed`/`total` are present exactly when `state` is `indexing`. The field SHALL describe the vault's semantic backend as read once for that call, not the request: it SHALL be present in `mode: "lexical"`, on the empty-filter early return, and on every entry of a fan-out envelope. It SHALL NOT be omitted when the backend is `ready`. A status read that does not complete in time SHALL be reported as `unavailable` for that call. `note` SHALL be present exactly when `state` is not `ready` — including the mid-request degradation path that reports `unavailable` over a backend that was `ready` — and SHALL state the consequence for the response carrying it: that the semantic leg did not run and the matches are lexical-only. `note` SHALL NOT restate the backend's `reason`, which travels on error payloads and is not exposed on this field.

#### Scenario: a ready vault says so

- **WHEN** `search_notes` runs against a vault whose index is built
- **THEN** the payload carries `semantic_status: { state: "ready" }` with no counters and no `note`

#### Scenario: a building index is visible in the search response

- **WHEN** `search_notes` runs against a vault that is still indexing
- **THEN** the payload carries `semantic_status: { state: "indexing", indexed, total }` alongside the lexical matches it could produce, and its `note` says the matches are lexical-only

#### Scenario: a degraded state explains itself on the response

- **WHEN** `search_notes` runs in `mode: "hybrid"` against a vault whose backend is `disabled` or `unavailable`
- **THEN** `semantic_status.note` states that the semantic leg did not run and the matches are lexical-only, so no prose in the tool description is needed to interpret the state

#### Scenario: a status read that times out

- **WHEN** the shared daemon does not answer the status read of a `search_notes` call in time
- **THEN** that payload carries `semantic_status.state` `unavailable` with its `note`, and lexical matches

#### Scenario: lexical mode still reports the index state

- **WHEN** `search_notes` is called with `mode: "lexical"` against a `ready` vault
- **THEN** the payload still carries `semantic_status: { state: "ready" }`, and no corpus read is made to produce it

#### Scenario: an empty filter set still reports the index state

- **WHEN** a `filter` matches no notes and `search_notes` returns early with no matches
- **THEN** the payload still carries `semantic_status`

#### Scenario: fan-out reports state per vault

- **WHEN** multiple vaults are registered, one indexing and one ready, and `search_notes` is called without `vault`
- **THEN** each per-vault entry of the envelope carries its own `semantic_status`
