## ADDED Requirements

### Requirement: A failed graph read is a dependency error
A graph read that fails SHALL fail that vault's tool call with `DEPENDENCY_ERROR`, the message `Graph read failed`, and `details: { vault, operation }` for `search_notes`, `get_note_links`, `get_vault_overview`, `query_notes`, `read_daily` and `get_similar_notes`, and SHALL fail a `vault://overview` resource read with the message `Graph read failed`. The read fails because the view could not answer, or because the session's own graph failed to build under `--no-semantic`. `operation` SHALL be the tool's name. A resource read carries no tool error envelope, so its code, and its `operation` (the resource's URI), SHALL reach only stderr. For a single-vault target the whole call SHALL fail. In a fan-out the vault SHALL appear in `failed_vaults` with that code, message and details, and the other vaults SHALL still answer. The failure's cause SHALL be written to stderr and SHALL NOT appear in the response. Under `--no-semantic`, the session's graph reader SHALL surface every failure as a `GraphReadError`. An error that is not a graph read failure SHALL propagate unchanged.

#### Scenario: A single-vault call fails with DEPENDENCY_ERROR

- **WHEN** `get_note_links` runs against a vault whose graph read fails with a timeout
- **THEN** the call fails with `DEPENDENCY_ERROR`, message `Graph read failed`, `details: { vault, operation: "get_note_links" }`, the timeout's message is written to stderr, and it does not appear in the response

#### Scenario: A fan-out lists the vault in failed_vaults

- **WHEN** `search_notes` fans out over two vaults, and one vault's backlink read fails
- **THEN** the other vault's matches are in `results_by_vault`, and the failing vault is in `failed_vaults` with code `DEPENDENCY_ERROR`, message `Graph read failed` and `details: { vault, operation: "search_notes" }`

#### Scenario: Every tool maps the failure

- **WHEN** a graph read fails during `get_vault_overview`, `query_notes`, `read_daily` or `get_similar_notes`
- **THEN** that call fails with `DEPENDENCY_ERROR` and message `Graph read failed`, with `operation` naming the tool

#### Scenario: The overview resource hides the cause

- **WHEN** a graph read fails during a `vault://overview` resource read
- **THEN** the read fails with the message `Graph read failed`, and the cause and the resource URI are written to stderr only

#### Scenario: A failed no-semantic build is a graph read failure

- **WHEN** the server runs with `--no-semantic` and the session's graph build throws
- **THEN** the graph reader rejects with a `GraphReadError` carrying the build's error as its cause

#### Scenario: Other errors pass through

- **WHEN** a graph read rejects with an error that is not a `GraphReadError`
- **THEN** the tool reports that error as before, not as `DEPENDENCY_ERROR`
