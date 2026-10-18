# semantic-backend-lifecycle Specification

## Purpose
TBD - created by archiving change own-backend-integration. Update Purpose after archive.
## Requirements
### Requirement: Semantic tools are served from the vault's own corpus through one backend

Every semantic surface of a vault — the semantic leg of `search_notes`, `get_similar_notes`, and `find_duplicates` — SHALL read the same active semantic backend of that vault, and that backend SHALL be served from the corpus the server owns under `<vault>/.neuro-vault/corpus/`, held by the vault's entry in the shared daemon or, in the in-process fallback, in the session. There SHALL be no fallback to any other corpus and no user-facing option selecting a backend. A backend SHALL expose exactly three reads: `nearest`, `nearestBlocks` and an asynchronous status; it SHALL NOT expose the corpus's vectors or a snapshot of them.

#### Scenario: the semantic leg ranks against the own corpus

- **WHEN** a vault has a compatible corpus under `.neuro-vault/corpus/` and `search_notes` runs with the semantic leg enabled
- **THEN** the notes it ranks come from that corpus, and no plugin-written corpus directory is read

#### Scenario: all three tools see one corpus per vault

- **WHEN** `search_notes`, `get_similar_notes` and `find_duplicates` are called against the same vault between two index updates
- **THEN** each is served from the same corpus, and no call mixes vectors from two corpora

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

Server startup SHALL NOT wait for any indexing or reconcile work. A vault whose active model's corpus directory holds a manifest compatible with the current corpus identity, and shards, SHALL be served immediately as `ready`, with a reconcile run in the background. A vault with no corpus for the active model — including one whose only corpora belong to other models, and one still in the single-corpus layout before its first pass moves it — or one whose active model's manifest is incompatible, SHALL report `indexing` and build its index in the background. Another model's corpus SHALL be neither served, nor announced, nor modified. When the active model's directory holds shards under an incompatible manifest, the server SHALL write one line to stderr naming the vault, the model and embedding version the stored corpus was built with, and the active ones, and stating that the corpus is being discarded and rebuilt — a rebuild SHALL never happen silently. Lexical search SHALL be fully available for every vault throughout.

#### Scenario: an existing compatible corpus serves immediately

- **WHEN** the server starts against a vault holding a corpus for the active model written under the current embed version and strategy
- **THEN** semantic calls succeed from the first request, and a reconcile runs in the background

#### Scenario: a cold vault starts instantly and indexes behind the scenes

- **WHEN** the server starts against a vault with no `.neuro-vault/corpus/`
- **THEN** the server is answering requests before indexing finishes, and the vault reports `indexing`

#### Scenario: an incompatible corpus is rebuilt, not served

- **WHEN** the active model's manifest records a different embedding version or strategy than the running server's
- **THEN** the vault reports `indexing` rather than `ready`, and no vector from the incompatible corpus is returned

#### Scenario: the rebuild is announced with both identities

- **WHEN** the server starts with `--model harrier-270m` against a vault whose `harrier-270m` corpus was built at a different embedding version
- **THEN** stderr carries one line for that vault naming `harrier-270m` with the stored embedding version and with the active one, before the vault's background rebuild completes

#### Scenario: another model's corpus is left alone

- **WHEN** the server starts with `--model harrier-270m` against a vault whose only corpus was built with `granite-97m`
- **THEN** the vault reports `indexing`, no rebuild line is written, and the `granite-97m` corpus is unchanged after the `harrier-270m` corpus is built

#### Scenario: a compatible corpus is not announced

- **WHEN** the server starts against a vault whose corpus matches the active profile
- **THEN** no rebuild line is written for that vault

#### Scenario: lexical search is unaffected by index state

- **WHEN** `search_notes` runs against a vault in any state other than `ready`
- **THEN** the call succeeds and returns lexical matches

### Requirement: A finished index is promoted live, per vault, without a restart

When a background index or reconcile writes a note, the write SHALL be visible to the vault's next semantic read, and a vault whose first corpus build completes SHALL report `ready` from that moment. Becoming `ready` SHALL NOT require a restart, SHALL NOT interrupt an in-flight request, and SHALL affect only the vault whose index finished. While a vault has never had a corpus loaded and is `indexing`, its semantic reads SHALL NOT be served.

#### Scenario: a vault becomes searchable mid-session

- **WHEN** a vault that reported `indexing` finishes building its index while the server keeps running
- **THEN** the next semantic call against it is served from the new corpus and its state is `ready`

#### Scenario: a note is never served with mixed vectors

- **WHEN** a pass re-embeds a note while a search is ranking against the vault
- **THEN** the search ranks that note either by all of its old vectors or by all of its new ones

#### Scenario: promotion is per vault

- **WHEN** one of two indexing vaults finishes
- **THEN** only that vault's state changes to `ready`

---

### Requirement: The corpus is kept fresh while the server runs

Each semantically enabled vault SHALL be watched for note changes by exactly one watcher per vault directory on the machine — the vault entry's, in the shared daemon or in the in-process fallback — and its corpus SHALL be brought back into agreement with the vault after a debounce interval of quiet. Reconcile passes for one vault SHALL NOT overlap: a change arriving during a pass SHALL be handled by a subsequent pass. The watcher SHALL follow the vault's scope: it SHALL ignore dot-paths, so the server's own writes under `.neuro-vault/` SHALL NOT trigger indexing, and SHALL NOT schedule a pass for a change the scope excludes. A watcher that cannot be started, or that fails later, SHALL be logged to stderr and SHALL degrade that vault to reconcile-on-attach without failing the server or any request.

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

#### Scenario: five sessions, one watcher

- **WHEN** five sessions using the shared daemon serve the same vault
- **THEN** one watcher and one reconcile loop run for that vault directory

#### Scenario: a broken watcher degrades rather than fails

- **WHEN** the file watcher cannot be started for a vault
- **THEN** the server starts, that vault serves the corpus its first reconcile produced, and the failure is reported on stderr

---

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

### Requirement: A vault can turn semantics off in its own config

A vault SHALL be able to opt out of semantics with `"semantic": false` in its `.neuro-vault/config.json`. Such a vault SHALL NOT be indexed, SHALL NOT be watched, and SHALL have nothing written under `.neuro-vault/corpus/`; its lexical surfaces SHALL work normally and its state SHALL be `disabled`. With the shared daemon, such a vault SHALL still be attached with `profiles: []`, so its lexical leg is served from the daemon's vault entry, which SHALL hold no corpus and run no watcher for it. A missing key SHALL mean enabled; a non-boolean value SHALL warn on stderr and be treated as enabled. The global `--no-semantic` flag SHALL continue to disable the semantic module for the whole process, SHALL take precedence over any per-vault value, and SHALL attach no vault and start no daemon. Semantic tools SHALL remain registered while any vault has semantics enabled.

#### Scenario: a disabled vault is never indexed

- **WHEN** a vault's config contains `{ "semantic": false }` and the server starts
- **THEN** no corpus directory is created for it, no watcher is started for it, and it reports `disabled`

#### Scenario: a disabled vault still answers lexically

- **WHEN** `search_notes` targets a vault with semantics disabled
- **THEN** the call succeeds with lexical matches

#### Scenario: a disabled vault's lexical leg is shared

- **WHEN** two shared sessions register a vault with `{ "semantic": false }` and each runs `search_notes` in `mode: "lexical"`
- **THEN** the daemon holds one vault entry for it with `clients 2`, no profile and a warm lexical cache

#### Scenario: one vault's opt-out does not affect its neighbours

- **WHEN** one of two registered vaults disables semantics
- **THEN** the semantic tools stay registered and the other vault is indexed and served as usual

#### Scenario: a malformed value falls back to enabled

- **WHEN** a vault's config contains `{ "semantic": "no" }`
- **THEN** the vault is treated as semantically enabled and a warning naming the config key is written to stderr

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

When its stdio transport closes the server SHALL release every resource that could keep the process alive: its connection to the shared daemon, which detaches it from every vault entry it attached, and, in the in-process fallback, every vault entry's watcher, pending debounce timers and reconcile pass. The process SHALL exit after its client disconnects instead of being held open.

#### Scenario: the process is not held open by a watcher

- **WHEN** the client disconnects from a running server in the in-process fallback that has watchers on two vaults
- **THEN** the watchers are closed and no pending timer keeps the process alive

#### Scenario: the client closes its end of the pipe

- **WHEN** the client closes the server's stdin, sending neither a shutdown request nor a signal
- **THEN** the server treats end of input as a disconnect, disposes every vault's backend, and the process exits

#### Scenario: disconnecting detaches from the daemon

- **WHEN** the only session attached to a vault entry disconnects
- **THEN** the daemon counts no client on that entry and starts its idle timer

#### Scenario: shutdown does not corrupt the corpus

- **WHEN** shutdown happens while a reconcile pass is mid-flight
- **THEN** the shards already written stay valid and the next run resumes from them

---

### Requirement: A backend tolerates other processes reconciling the same vault

A vault's corpus SHALL keep being served, and the vault SHALL keep its reported state, while its reconcile pass waits for another process that holds the vault's reconcile lock. After a pass that had to wait for another holder, the vault's corpus SHALL be refreshed from the shard files even when that pass itself embedded, renamed and deleted nothing, because the holder may have changed the corpus. A pass that fails because the lock stayed held past the wait bound SHALL leave the vault in the state it reported before that pass began and SHALL NOT change its corpus; one line on stderr SHALL name the vault, the holder's process id and the lock file, and another pass SHALL be scheduled on the retry backoff rather than give up. A vault entry being disposed SHALL stop waiting for the lock.

#### Scenario: A note re-embedded by another process is served after the wait

- **WHEN** a vault entry's pass waits while another process holding the lock re-embeds an edited note, and the waiting pass then reports that note reused
- **THEN** the vault's next semantic call ranks the note by its new vectors

#### Scenario: A lock timeout keeps a serving vault ready

- **WHEN** a vault reporting `ready` runs a pass that fails because another process held the lock past the wait bound
- **THEN** the vault still reports `ready` with the same corpus, stderr names the holder's process id and `reconcile.lock`, and another pass is scheduled on the retry backoff

#### Scenario: A lock timeout keeps an unavailable vault unavailable

- **WHEN** a vault reporting `unavailable` runs its retry pass, and that pass fails because another process held the lock past the wait bound
- **THEN** the vault reports `unavailable` with the same reason after the pass, not `indexing`, and another pass is scheduled on the retry backoff

#### Scenario: A pass that did not wait reads nothing back

- **WHEN** a pass acquires the lock without waiting and embeds, renames and deletes nothing over a corpus already loaded
- **THEN** the corpus is not re-read from the shard files

#### Scenario: Disposal stops the wait

- **WHEN** a vault entry is disposed while its pass is waiting for another process's lock
- **THEN** the pass stops waiting, the corpus is not changed, and the other process's lock is left in place

