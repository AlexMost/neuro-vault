## MODIFIED Requirements

### Requirement: Reconcile passes over one vault are serialised across processes

A reconcile pass SHALL hold the vault's reconcile lock — the file `<vault>/.neuro-vault/corpus/reconcile.lock`, shared by every model — from before it migrates or reads the manifest until it ends, and SHALL release it when it ends, whether it completed, failed, or was aborted. The lock SHALL be acquired by exclusive creation of that file with content naming the holder's host name, its process id and a token unique to that acquisition, and SHALL be released only while the file still holds that exact content. When the file exists, the pass SHALL treat it as stale and replace it if it names the pass's own host and either a process that is not running there or the pass's own process, or if its content has been unparseable for more than one second; it SHALL replace a stale lock only if the file still holds the content judged stale. A lock naming another host SHALL be treated as live, since its process cannot be checked from here. Otherwise the pass SHALL wait for the holder, polling with a backoff that starts at 50 milliseconds, doubles, and is capped at 2 seconds, for at most 30 minutes in total, after which it SHALL fail with an error naming the lock file, the holder's host and the holder's process id. A pass that finds a live holder SHALL report it once to its caller, naming the holder's process id, and a pass that is aborted while waiting SHALL stop waiting and return without reading or writing the corpus. Because the manifest and the shard listing are read only after the lock is held, a pass that waited SHALL reuse every shard the previous holder wrote that matches the vault. Within one process, a vault directory SHALL have exactly one reconcile loop, and each of its passes SHALL hold the lock once while it reconciles every attached profile of that vault in turn.

#### Scenario: Two concurrent passes do the work once

- **WHEN** two processes start a reconcile of the same vault and model at the same moment, against a vault with three new notes
- **THEN** one pass embeds the three notes, the other waits for it and then reports all three reused, and no note is embedded twice

#### Scenario: A waiting pass after a rebuild does not rebuild again

- **WHEN** one process rebuilds a model directory whose manifest was incompatible while a second process of the same build waits for the lock
- **THEN** the second pass reads the rewritten manifest as compatible and discards nothing

#### Scenario: A dead holder is replaced

- **WHEN** the lock file names a process id that is no longer running
- **THEN** the pass replaces the lock without waiting and runs

#### Scenario: A holder on another host is never taken over

- **WHEN** the lock names another host, with a process id that does not exist on this host
- **THEN** the pass waits for it rather than replacing it

#### Scenario: A live holder past the bound fails the pass

- **WHEN** the lock is held by a running process for longer than 30 minutes while a pass waits
- **THEN** the waiting pass fails with an error naming `reconcile.lock`, the holder's host and its process id, having read and written nothing in the corpus

#### Scenario: The lock is released after a failure

- **WHEN** a pass throws after acquiring the lock
- **THEN** the lock file no longer exists and the next pass acquires it without waiting

#### Scenario: An abort stops the wait

- **WHEN** a pass is aborted while it waits for a live holder
- **THEN** it returns promptly with an empty summary and leaves the holder's lock file in place


#### Scenario: Two profiles of one vault share one acquisition

- **WHEN** a vault entry has two profiles attached and a pass runs
- **THEN** the lock is acquired once, both profiles are reconciled, and the lock is released once
