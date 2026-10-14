## ADDED Requirements

### Requirement: A backend tolerates other processes reconciling the same vault

A vault's backend SHALL keep serving its current snapshot, and SHALL keep its reported state, while its reconcile pass waits for another process that holds the vault's reconcile lock. After a pass that had to wait for another holder, the backend SHALL replace its snapshot with one decoded from the corpus on disk even when that pass itself embedded, renamed and deleted nothing, because the holder may have changed the corpus. A pass that fails because the lock stayed held past the wait bound SHALL NOT change the vault's reported state or snapshot; the backend SHALL write one line on stderr naming the vault, the holder's process id and the lock file, and SHALL schedule another pass on its retry backoff rather than give up. A backend being disposed SHALL stop waiting for the lock.

#### Scenario: A note re-embedded by another server is served after the wait

- **WHEN** a vault served by two server processes has a note edited, one process re-embeds it while the other waits for the lock, and the waiting process's pass then reports that note reused
- **THEN** the waiting process's next semantic call ranks the note by its new vectors

#### Scenario: A lock timeout keeps a serving vault ready

- **WHEN** a vault reporting `ready` runs a pass that fails because another process held the lock past the wait bound
- **THEN** the vault still reports `ready` with the same snapshot, stderr names the holder's process id and `reconcile.lock`, and another pass is scheduled on the retry backoff

#### Scenario: A pass that did not wait keeps the reload rule

- **WHEN** a pass acquires the lock without waiting and embeds, renames and deletes nothing over a snapshot already loaded
- **THEN** the snapshot is not reloaded

#### Scenario: Disposal stops the wait

- **WHEN** the server's transport closes while a vault's pass is waiting for another process's lock
- **THEN** the pass stops waiting, the backend promotes nothing, and the other process's lock is left in place
