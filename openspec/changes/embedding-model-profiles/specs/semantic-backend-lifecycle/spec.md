## MODIFIED Requirements

### Requirement: Startup serves what it can and never blocks

Server startup SHALL NOT wait for any indexing or reconcile work. A vault whose stored manifest is compatible with the current corpus identity and whose corpus holds shards SHALL be served immediately as `ready`, with a reconcile run in the background. A vault with no corpus, or one whose manifest is incompatible, SHALL report `indexing` and build its index in the background. When a vault's corpus holds shards under an incompatible manifest, the server SHALL write one line to stderr naming the vault, the model and embedding version the stored corpus was built with, and the active ones, and stating that the corpus is being discarded and rebuilt — a rebuild SHALL never happen silently. Lexical search SHALL be fully available for every vault throughout.

#### Scenario: an existing compatible corpus serves immediately

- **WHEN** the server starts against a vault holding a corpus written under the current embed version, model and strategy
- **THEN** semantic calls succeed from the first request, and a reconcile runs in the background

#### Scenario: a cold vault starts instantly and indexes behind the scenes

- **WHEN** the server starts against a vault with no `.neuro-vault/corpus/`
- **THEN** the server is answering requests before indexing finishes, and the vault reports `indexing`

#### Scenario: an incompatible corpus is rebuilt, not served

- **WHEN** a vault's manifest records a different model or strategy than the running server's
- **THEN** the vault reports `indexing` rather than `ready`, and no vector from the incompatible corpus is returned

#### Scenario: the rebuild is announced with both identities

- **WHEN** the server starts with `--model harrier-270m` against a vault whose corpus was built with `granite-97m`
- **THEN** stderr carries one line for that vault naming `granite-97m` as the stored model and `harrier-270m` as the active one, before the vault's background rebuild completes

#### Scenario: a compatible corpus is not announced

- **WHEN** the server starts against a vault whose corpus matches the active profile
- **THEN** no rebuild line is written for that vault

#### Scenario: lexical search is unaffected by index state

- **WHEN** `search_notes` runs against a vault in any state other than `ready`
- **THEN** the call succeeds and returns lexical matches

---

### Requirement: One embedding model serves the whole process, queries first

The process SHALL load the one embedding model named by its selected profile and SHALL serialise every embedding request through a single queue shared by all vaults. Indexing work MAY be embedded in batches of a single note's inputs, at most the provider's maximum batch size per batch. A query-side embedding SHALL be served ahead of every queued indexing batch, so search latency during indexing is bounded by the one batch in flight rather than by the size of the index.

#### Scenario: two vaults indexing share the model

- **WHEN** two vaults are indexing at the same time
- **THEN** both make progress, their reported progress counters stay per vault, and only one model is loaded

#### Scenario: a search is not queued behind a cold index

- **WHEN** `search_notes` runs against a `ready` vault while another vault is embedding thousands of notes
- **THEN** the query's embedding is served ahead of the pending indexing work

#### Scenario: a query waits for at most one batch

- **WHEN** a query is submitted while one indexing batch is being embedded and further indexing batches are queued
- **THEN** the query's embedding runs as soon as the in-flight batch finishes, before any of the queued batches
