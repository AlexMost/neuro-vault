## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: A backend tolerates other processes reconciling the same vault

A vault's backend SHALL keep serving its current snapshot, and SHALL keep its reported state, while its reconcile pass waits for another process that holds the vault's reconcile lock. After a pass that had to wait for another holder, the backend SHALL replace its snapshot with one decoded from the corpus on disk even when that pass itself embedded, renamed and deleted nothing, because the holder may have changed the corpus. A pass that fails because the lock stayed held past the wait bound SHALL leave the vault in the state it reported before that pass began, and SHALL NOT change its snapshot; the backend SHALL write one line on stderr naming the vault, the holder's process id and the lock file, and SHALL schedule another pass on its retry backoff rather than give up. A backend being disposed SHALL stop waiting for the lock.

#### Scenario: A note re-embedded by another server is served after the wait

- **WHEN** a vault served by two server processes has a note edited, one process re-embeds it while the other waits for the lock, and the waiting process's pass then reports that note reused
- **THEN** the waiting process's next semantic call ranks the note by its new vectors

#### Scenario: A lock timeout keeps a serving vault ready

- **WHEN** a vault reporting `ready` runs a pass that fails because another process held the lock past the wait bound
- **THEN** the vault still reports `ready` with the same snapshot, stderr names the holder's process id and `reconcile.lock`, and another pass is scheduled on the retry backoff

#### Scenario: A lock timeout keeps an unavailable vault unavailable

- **WHEN** a vault reporting `unavailable` runs its retry pass, and that pass fails because another process held the lock past the wait bound
- **THEN** the vault reports `unavailable` with the same reason after the pass, not `indexing`, and another pass is scheduled on the retry backoff

#### Scenario: A pass that did not wait keeps the reload rule

- **WHEN** a pass acquires the lock without waiting and embeds, renames and deletes nothing over a snapshot already loaded
- **THEN** the snapshot is not reloaded

#### Scenario: Disposal stops the wait

- **WHEN** the server's transport closes while a vault's pass is waiting for another process's lock
- **THEN** the pass stops waiting, the backend promotes nothing, and the other process's lock is left in place
