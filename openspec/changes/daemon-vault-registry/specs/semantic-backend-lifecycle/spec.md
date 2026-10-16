## MODIFIED Requirements

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
