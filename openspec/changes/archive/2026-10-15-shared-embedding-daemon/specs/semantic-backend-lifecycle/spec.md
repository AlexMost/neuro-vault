## MODIFIED Requirements

### Requirement: One embedding model serves the whole process, queries first

The process SHALL obtain every embedding it needs through one embedding provider built for its selected profile and SHALL serialise every embedding request through a single per-process queue shared by all vaults. By default that provider is the daemon-backed facade, so the model named by the profile is loaded once per machine per installed version and shared by every session and `index` run; with `--no-shared` the process loads the model itself. Indexing work MAY be embedded in batches of a single note's inputs, at most the provider's maximum batch size per batch. A query-side embedding SHALL be served ahead of every queued indexing batch within the process, and, when the daemon serves several sessions, ahead of other sessions' queued indexing batches as well, so search latency during indexing is bounded by the one batch in flight rather than by the size of any index.

#### Scenario: two vaults indexing share the model

- **WHEN** two vaults are indexing at the same time
- **THEN** both make progress, their reported progress counters stay per vault, and only one model is loaded

#### Scenario: two sessions share the model

- **WHEN** two server sessions of the same version run with the default provider
- **THEN** only one model is loaded on the machine, in the daemon, and both sessions embed through it

#### Scenario: a search is not queued behind a cold index

- **WHEN** `search_notes` runs against a `ready` vault while another vault is embedding thousands of notes
- **THEN** the query's embedding is served ahead of the pending indexing work

#### Scenario: a search is not queued behind another session's cold index

- **WHEN** session A is embedding thousands of notes through the daemon and session B runs `search_notes`
- **THEN** B's query embedding is served ahead of A's queued batches

#### Scenario: a query waits for at most one batch

- **WHEN** a query is submitted while one indexing batch is being embedded and further indexing batches are queued
- **THEN** the query's embedding runs as soon as the in-flight batch finishes, before any of the queued batches
