## ADDED Requirements

### Requirement: Semantic tools are served from the vault's own corpus through one backend

Every semantic surface of a vault — the semantic leg of `search_notes`, `get_similar_notes`, and `find_duplicates` — SHALL read the same active semantic backend of that vault, and that backend SHALL be built from the corpus the server owns under `<vault>/.neuro-vault/corpus/`. There SHALL be no fallback to any other corpus and no user-facing option selecting a backend. A backend SHALL expose exactly two reads: a corpus snapshot (`{ sources, basenameIndex }`) and a status.

#### Scenario: the semantic leg ranks against the own corpus

- **WHEN** a vault has a compatible corpus under `.neuro-vault/corpus/` and `search_notes` runs with the semantic leg enabled
- **THEN** the notes it ranks come from that corpus, and no plugin-written corpus directory is read

#### Scenario: all three tools see one corpus per vault

- **WHEN** `search_notes`, `get_similar_notes` and `find_duplicates` are called against the same vault between two index updates
- **THEN** each is served from the same snapshot, and no call mixes vectors from two corpora

#### Scenario: each vault has its own backend

- **WHEN** two vaults are registered and one is still building its index while the other is serving
- **THEN** the serving vault answers semantic calls normally and the other vault's state does not affect it

---

### Requirement: A backend reports one of four states, and no state is permanent

A backend's status SHALL report `state` as exactly one of `ready`, `indexing`, `disabled`, or `unavailable`. `indexing` SHALL carry `indexed` and `total` note counters. `unavailable` SHALL carry a human-readable reason. `disabled` SHALL mean the vault turned semantics off deliberately and SHALL NOT be reported for any failure. No state other than `disabled` SHALL be terminal: a vault that failed to index SHALL return to `ready` when a later pass succeeds, without a restart.

#### Scenario: indexing carries progress

- **WHEN** a vault is building its index and 120 of 840 in-scope notes are done
- **THEN** its status is `{ state: "indexing", indexed: 120, total: 840 }`

#### Scenario: counters exist before the scan completes

- **WHEN** a vault has begun indexing but has not yet finished listing its in-scope notes
- **THEN** its status is `{ state: "indexing", indexed: 0, total: 0 }` rather than omitting the counters

#### Scenario: an index pass that produced nothing is not ready

- **WHEN** a cold vault's pass finishes having failed every note it tried — no embedding model could be reached — so the corpus it would serve is empty
- **THEN** its state is `unavailable` with a reason, never `ready` over the empty corpus

#### Scenario: a failure is never reported as disabled

- **WHEN** a vault's corpus cannot be read or reconciled because of a filesystem error
- **THEN** its state is `unavailable` with the reason, and never `disabled`

#### Scenario: a transient failure is not a life sentence

- **WHEN** a vault reports `unavailable` after a failed pass and a later pass over the same vault succeeds
- **THEN** its state becomes `ready` and semantic calls are served, with no restart in between

---

### Requirement: Startup serves what it can and never blocks

Server startup SHALL NOT wait for any indexing or reconcile work. A vault whose stored manifest is compatible with the current corpus identity and whose corpus holds shards SHALL be served immediately as `ready`, with a reconcile run in the background. A vault with no corpus, or one whose manifest is incompatible, SHALL report `indexing` and build its index in the background. Lexical search SHALL be fully available for every vault throughout.

#### Scenario: an existing compatible corpus serves immediately

- **WHEN** the server starts against a vault holding a corpus written under the current embed version, model and strategy
- **THEN** semantic calls succeed from the first request, and a reconcile runs in the background

#### Scenario: a cold vault starts instantly and indexes behind the scenes

- **WHEN** the server starts against a vault with no `.neuro-vault/corpus/`
- **THEN** the server is answering requests before indexing finishes, and the vault reports `indexing`

#### Scenario: an incompatible corpus is rebuilt, not served

- **WHEN** a vault's manifest records a different model or strategy than the running server's
- **THEN** the vault reports `indexing` rather than `ready`, and no vector from the incompatible corpus is returned

#### Scenario: lexical search is unaffected by index state

- **WHEN** `search_notes` runs against a vault in any state other than `ready`
- **THEN** the call succeeds and returns lexical matches

---

### Requirement: A finished index is promoted live, per vault, without a restart

When a background index or reconcile completes and the corpus changed, the backend SHALL replace its snapshot in one atomic step and SHALL report `ready` from that moment. Promotion SHALL NOT require a restart, SHALL NOT interrupt an in-flight request, and SHALL affect only the vault whose index finished.

#### Scenario: a vault becomes searchable mid-session

- **WHEN** a vault that reported `indexing` finishes building its index while the server keeps running
- **THEN** the next semantic call against it is served from the new corpus and its state is `ready`

#### Scenario: an in-flight request keeps a coherent snapshot

- **WHEN** a promotion happens while a search is already ranking against the previous snapshot
- **THEN** that search completes against the snapshot it started with, without mixing the two

#### Scenario: promotion is per vault

- **WHEN** one of two indexing vaults finishes
- **THEN** only that vault's state changes to `ready`

---

### Requirement: The corpus is kept fresh while the server runs

The server SHALL watch each semantically enabled vault for note changes in-process and SHALL bring that vault's corpus back into agreement with it after a debounce interval of quiet. Reconcile passes for one vault SHALL NOT overlap: a change arriving during a pass SHALL be handled by a subsequent pass. The watcher SHALL ignore dot-paths, so the server's own writes under `.neuro-vault/` SHALL NOT trigger indexing. A watcher that cannot be started, or that fails later, SHALL be logged to stderr and SHALL degrade that vault to reconcile-on-start without failing the server or any request.

#### Scenario: an edited note is re-embedded without a restart

- **WHEN** a note's text changes on disk and the debounce interval passes with no further change
- **THEN** the vault's corpus reflects the new text, and semantic results change accordingly

#### Scenario: a burst of saves costs one pass

- **WHEN** a note is saved repeatedly with less than the debounce interval between saves
- **THEN** one reconcile pass runs after the burst rather than one per save

#### Scenario: a deleted note leaves the served corpus

- **WHEN** a note is deleted and the debounce interval passes
- **THEN** that note is absent from subsequent semantic results

#### Scenario: corpus writes do not feed the watcher

- **WHEN** indexing writes shards under `.neuro-vault/corpus/`
- **THEN** no reconcile pass is scheduled as a result of those writes

#### Scenario: a broken watcher degrades rather than fails

- **WHEN** the file watcher cannot be started for a vault
- **THEN** the server starts, that vault serves the corpus its startup reconcile produced, and the failure is reported on stderr

---

### Requirement: One embedding model serves the whole process, queries first

The process SHALL load one embedding model and SHALL serialise every embedding request through a single queue shared by all vaults. A query-side embedding SHALL be served ahead of queued indexing work, so search latency during indexing is bounded by the request in flight rather than by the size of the index.

#### Scenario: two vaults indexing share the model

- **WHEN** two vaults are indexing at the same time
- **THEN** both make progress, their reported progress counters stay per vault, and only one model is loaded

#### Scenario: a search is not queued behind a cold index

- **WHEN** `search_notes` runs against a `ready` vault while another vault is embedding thousands of notes
- **THEN** the query's embedding is served ahead of the pending indexing work

---

### Requirement: A vault can turn semantics off in its own config

A vault SHALL be able to opt out of semantics with `"semantic": false` in its `.neuro-vault/config.json`. Such a vault SHALL NOT be indexed, SHALL NOT be watched, and SHALL have nothing written under `.neuro-vault/corpus/`; its lexical surfaces SHALL work normally and its state SHALL be `disabled`. A missing key SHALL mean enabled; a non-boolean value SHALL warn on stderr and be treated as enabled. The global `--no-semantic` flag SHALL continue to disable the semantic module for the whole process, and SHALL take precedence over any per-vault value. Semantic tools SHALL remain registered while any vault has semantics enabled.

#### Scenario: a disabled vault is never indexed

- **WHEN** a vault's config contains `{ "semantic": false }` and the server starts
- **THEN** no corpus directory is created for it, no watcher is started for it, and it reports `disabled`

#### Scenario: a disabled vault still answers lexically

- **WHEN** `search_notes` targets a vault with semantics disabled
- **THEN** the call succeeds with lexical matches

#### Scenario: one vault's opt-out does not affect its neighbours

- **WHEN** one of two registered vaults disables semantics
- **THEN** the semantic tools stay registered and the other vault is indexed and served as usual

#### Scenario: a malformed value falls back to enabled

- **WHEN** a vault's config contains `{ "semantic": "no" }`
- **THEN** the vault is treated as semantically enabled and a warning naming the config key is written to stderr

---

### Requirement: The embeddings-only tools report why they cannot answer

`get_similar_notes` and `find_duplicates` SHALL fail with a structured error rather than an empty result whenever the targeted vault's backend is not `ready`: `SEMANTIC_INDEX_BUILDING` while it is `indexing`, carrying `indexed` and `total` in its details; `SEMANTIC_DISABLED` while it is `disabled`, naming the config key that turns it back on; and `SEMANTIC_INDEX_NOT_FOUND` while it is `unavailable`, carrying the reason and a hint naming the CLI index command. No error hint SHALL instruct the user to install or run an Obsidian plugin.

#### Scenario: a building index is reported with progress

- **WHEN** `find_duplicates` targets a vault that is still indexing
- **THEN** the call fails with `SEMANTIC_INDEX_BUILDING` whose details carry the vault name, `indexed` and `total`

#### Scenario: a disabled vault names the config key

- **WHEN** `get_similar_notes` targets a vault with `"semantic": false`
- **THEN** the call fails with `SEMANTIC_DISABLED` and the message names `.neuro-vault/config.json` and the `semantic` key

#### Scenario: an unavailable corpus points at the index command

- **WHEN** `get_similar_notes` targets a vault whose corpus could not be built or read
- **THEN** the call fails with `SEMANTIC_INDEX_NOT_FOUND`, the reason is present in the details, and the hint names the `index` CLI command rather than any plugin

---

### Requirement: Background work stops when the server's transport closes

The server SHALL release every vault's background resources — file watchers and pending debounce timers — when its stdio transport closes, so the process exits after its client disconnects instead of being held open by a watcher.

#### Scenario: the process is not held open by a watcher

- **WHEN** the client disconnects from a running server that has watchers on two vaults
- **THEN** the watchers are closed and no pending timer keeps the process alive

#### Scenario: the client closes its end of the pipe

- **WHEN** the client closes the server's stdin, sending neither a shutdown request nor a signal
- **THEN** the server treats end of input as a disconnect, disposes every vault's backend, and the process exits

#### Scenario: shutdown does not corrupt the corpus

- **WHEN** shutdown happens while a reconcile pass is mid-flight
- **THEN** the shards already written stay valid and the next run resumes from them
