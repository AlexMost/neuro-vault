## ADDED Requirements

### Requirement: search_notes reports the vault's semantic index state

Every per-vault `search_notes` payload SHALL carry `semantic_status: { state, indexed?, total? }`, where `state` is one of `ready`, `indexing`, `disabled`, or `unavailable`, and `indexed`/`total` are present exactly when `state` is `indexing`. The field SHALL describe the vault's semantic backend, not the request: it SHALL be present in `mode: "lexical"`, on the empty-filter early return, and on every entry of a fan-out envelope. It SHALL NOT be omitted when the backend is `ready`.

#### Scenario: a ready vault says so

- **WHEN** `search_notes` runs against a vault whose index is built
- **THEN** the payload carries `semantic_status: { state: "ready" }` with no counters

#### Scenario: a building index is visible in the search response

- **WHEN** `search_notes` runs against a vault that is still indexing
- **THEN** the payload carries `semantic_status: { state: "indexing", indexed, total }` alongside the lexical matches it could produce

#### Scenario: lexical mode still reports the index state

- **WHEN** `search_notes` is called with `mode: "lexical"` against a `ready` vault
- **THEN** the payload still carries `semantic_status: { state: "ready" }`, and no corpus snapshot is read to produce it

#### Scenario: an empty filter set still reports the index state

- **WHEN** a `filter` matches no notes and `search_notes` returns early with no matches
- **THEN** the payload still carries `semantic_status`

#### Scenario: fan-out reports state per vault

- **WHEN** multiple vaults are registered, one indexing and one ready, and `search_notes` is called without `vault`
- **THEN** each per-vault entry of the envelope carries its own `semantic_status`

---

## MODIFIED Requirements

### Requirement: Lexical leg is independent of the embedding corpus

The lexical leg SHALL function whatever state the vault's embedding corpus is in — absent, still building, disabled, or unreadable — and `mode: "lexical"` SHALL NOT read a corpus snapshot at all. Semantic-leg failure or emptiness SHALL NOT fail the lexical leg.

#### Scenario: lexical search works without a corpus

- **WHEN** a vault has no embedding corpus yet and `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** the call succeeds and `matches[]` contains lexically-sourced entries with title/heading/body evidence

#### Scenario: lexical search works while the index builds

- **WHEN** a vault is indexing and `search_notes` is called with `{ query: "пошук" }`
- **THEN** the call succeeds with lexical matches and reports `semantic_status: { state: "indexing", indexed, total }`

---

### Requirement: Single-source degradation preserves source order

In `mode: "lexical"`, or whenever the vault's semantic backend is not `ready` (indexing, disabled, or unavailable), the merge SHALL degrade to the lexical source alone: `matches[]` SHALL preserve the lexical ordering, every `found_in` SHALL contain only `lexical:*` values, and semantic evidence fields SHALL be absent. No corpus snapshot SHALL be read in `mode: "lexical"`.

#### Scenario: lexical mode yields a purely lexical merged list

- **WHEN** `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** `matches[]` is ordered exactly as the lexical source and no entry carries `similarity`, `blocks`, or `expansion_similarity`

#### Scenario: a non-ready backend degrades the same way

- **WHEN** `search_notes` is called without `mode` against a vault whose backend is `indexing` or `disabled`
- **THEN** `matches[]` carries only `lexical:*` provenance and the response reports the corresponding `semantic_status`
