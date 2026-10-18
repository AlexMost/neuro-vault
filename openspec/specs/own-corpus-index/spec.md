# own-corpus-index Specification

## Purpose
The embedding corpus the server builds and owns: where it lives, the shard and manifest schema, atomic writes and crash recovery, membership from the vault scope, and the incremental reconcile that keeps it in agreement with the vault.
## Requirements
### Requirement: The server builds and owns an embedding corpus stored inside the vault

The server SHALL build its own embedding corpus and SHALL store it under `<vault>/.neuro-vault/corpus/<model_key>/`, one directory per vault per embedding model profile, named by the profile's model key, so a vault carries its corpora with it and processes serving different models never read, rewrite or discard each other's corpus. A model directory's name SHALL be a single path segment that starts with an ASCII letter or digit and contains only ASCII letters, digits, `.`, `_` and `-`, at most 64 characters, and SHALL NOT equal, compared case-insensitively, any name the corpus root reserves for itself: `notes`, `manifest.json` or `reconcile.lock`. The corpus directory SHALL be a dot-path, and therefore unconditionally excluded from vault scope. This supersedes the earlier decision that the server never writes embeddings; consuming a third-party corpus read-only is no longer the only source of vectors.

#### Scenario: Corpus writes land under the model's directory

- **WHEN** a vault is indexed with the `harrier-270m` profile
- **THEN** every shard and the manifest the indexer writes are under that vault's `.neuro-vault/corpus/harrier-270m/`, and no scope-governed surface reports any of those files

#### Scenario: Each vault gets its own corpus

- **WHEN** two vaults are indexed by the same process
- **THEN** each vault's shards and manifest live under its own root, and neither corpus contains an entry for the other vault's notes

#### Scenario: Two models keep separate corpora

- **WHEN** a vault is indexed with `granite-97m` and then with `harrier-270m`
- **THEN** both `.neuro-vault/corpus/granite-97m/` and `.neuro-vault/corpus/harrier-270m/` exist, the `granite-97m` shards and manifest are byte-for-byte unchanged by the second run, and indexing with `granite-97m` again embeds nothing

#### Scenario: An unsafe model key is refused

- **WHEN** a corpus store is opened for a model key containing a path separator, starting with a dot, or equal to `Notes`, `manifest.json` or `reconcile.lock`
- **THEN** opening fails with an error naming the key, and nothing is read or written

### Requirement: The indexer keeps the corpus out of the vault's git history

The indexer SHALL, on first index, ensure the vault's root `.gitignore` ignores the corpus directory by appending a single `.neuro-vault/corpus/` entry when that file exists and does not already ignore it. It SHALL NOT create a `.gitignore` that does not exist, SHALL NOT rewrite any other line, and SHALL NOT ignore `.neuro-vault/` as a whole, since other contents of that directory are meant to be versioned. Failure to update the file SHALL produce a warning on stderr and SHALL NOT fail indexing.

#### Scenario: The entry is appended once

- **WHEN** a vault with a root `.gitignore` that does not mention the corpus is indexed twice
- **THEN** exactly one `.neuro-vault/corpus/` entry is present after both runs, and every pre-existing line is unchanged

#### Scenario: An unwritable gitignore does not fail the index

- **WHEN** the vault's root `.gitignore` cannot be written
- **THEN** indexing completes normally and a warning naming the vault is emitted on stderr, never on stdout

### Requirement: Each note is stored as one self-describing shard

The corpus SHALL store one shard per indexed note, carrying the note's vault-relative path, its content hash, its modification time and size, its note-level vector, and its blocks with their key, heading, 1-based inclusive line span and vector. Change detection SHALL be answerable from shards alone, without consulting the manifest. A note that is below the embedding size gate SHALL still have a shard, with no note-level vector, so it is not re-read on every pass. Block entries without a vector SHALL NOT be written.

#### Scenario: A shard identifies its own note

- **WHEN** a shard is read from disk
- **THEN** the path, content hash, mtime and size it carries are sufficient to decide whether the corresponding note has changed

#### Scenario: A gated note is recorded without a note-level vector

- **WHEN** a note below the size gate is indexed
- **THEN** its shard exists, its note-level vector is absent, and only its blocks that reached the gate carry vectors

### Requirement: Vectors round-trip losslessly

The corpus SHALL encode every vector as base64 of a little-endian `Float32Array` and SHALL decode it bit-exactly, so a stored vector equals the vector the model produced with no precision loss.

#### Scenario: A decoded vector equals the embedded one

- **WHEN** a vector is written to a shard and read back
- **THEN** every component equals the original float32 value exactly, and the vector's length equals the model's dimension

### Requirement: The manifest records corpus identity and gates a rebuild

Each model directory SHALL carry one manifest recording everything that produced its vectors — the embedding provider, the model profile key, the model repository id and its pinned revision, the weight dtype, the vector dimension, the pooling method, the maximum input length in tokens, the embedding version, and the extraction strategy identifier — plus its creation time, and SHALL write it only when those values change. The recorded identity SHALL be taken from the active embedding provider, not from constants of the corpus library. Reconcile SHALL compare the manifest in the active model's directory against the running identity and SHALL discard every shard of that directory and rebuild it when any recorded field differs, or when the manifest is missing or unreadable while shards exist in that directory. A rebuild SHALL NOT modify or delete anything outside the active model's directory. A manifest written by an earlier version that lacks some of these fields SHALL still be read far enough to name the model and embedding version it records, and SHALL be treated as incompatible. A change to vault scope or exclusions SHALL NOT trigger a rebuild, since membership is not a property of the vectors.

#### Scenario: An identity change within a model rebuilds that model's corpus only

- **WHEN** the manifest in `.neuro-vault/corpus/harrier-270m/` names a different revision, dimension, pooling method, maximum input length, embedding version or extraction strategy than the running `harrier-270m` identity, and `.neuro-vault/corpus/granite-97m/` also exists
- **THEN** every shard under `harrier-270m/` is discarded and that directory is rebuilt from the vault, and nothing under `granite-97m/` changes

#### Scenario: A legacy manifest is named, then rebuilt

- **WHEN** reconcile for `harrier-270m` meets, in `.neuro-vault/corpus/harrier-270m/`, a manifest at embedding version 1 without provider, revision, dtype, pooling or maximum-length fields
- **THEN** the rebuild proceeds, and the rebuild report names `harrier-270m` and embedding version 1 as the identity being replaced

#### Scenario: An exclusion change is not a rebuild

- **WHEN** the vault's exclusion configuration changes so that some notes leave scope and others enter it
- **THEN** the next reconcile deletes the shards of departed notes and embeds the newly included ones, leaving every other shard and the embedding version untouched

### Requirement: Every corpus write is atomic and corruption is recoverable

The corpus SHALL write shards and the manifest atomically, so a reader observes either the previous file or the complete new one and never a partial write. A shard that cannot be parsed, fails validation, names a path inconsistent with the file it was found under, or holds a vector whose dimension differs from the manifest's SHALL be treated as absent and its note re-embedded on the next pass. No corpus corruption SHALL be fatal to the process.

#### Scenario: An interrupted write leaves the previous shard intact

- **WHEN** a shard write is interrupted before completion
- **THEN** the previously stored shard is still readable and unchanged

#### Scenario: A shard whose vector has the wrong dimension is rejected

- **WHEN** a shard holds a vector whose length differs from the dimension the manifest declares
- **THEN** the shard reads as absent and its note is re-embedded, and no similarity is ever computed against a vector of the wrong dimension

#### Scenario: A corrupt shard is repaired by the next reconcile

- **WHEN** a shard file contains invalid content and its note still exists in scope
- **THEN** reconcile re-embeds that note, overwrites the shard, and reports no failure to the caller

### Requirement: Corpus membership is the vault scope

The set of notes the corpus covers SHALL be exactly the set the vault scope makes visible; the indexer SHALL take its path set from the scoped vault scan and SHALL NOT apply exclusion rules of its own.

#### Scenario: An excluded note is never embedded

- **WHEN** a note is excluded by the vault's scope
- **THEN** no shard exists for it, and if one existed before the exclusion it is deleted on the next reconcile

### Requirement: Reconcile is incremental and hash-truthful

Reconcile SHALL bring the corpus into agreement with the vault by diffing the scoped path set against the stored shards. An unchanged modification time and size SHALL let a note be skipped without reading it; when either differs, the note's content hash SHALL decide, and a matching hash SHALL update the shard's metadata without re-embedding. A note with no shard, or whose hash differs from its shard's, SHALL be embedded. A shard whose note has left scope or disk SHALL be deleted.

#### Scenario: An untouched vault costs no embedding

- **WHEN** reconcile runs twice with no vault change in between
- **THEN** the second run embeds nothing, deletes nothing, and reports every note as up to date

#### Scenario: A touched but unmodified file is not re-embedded

- **WHEN** a note's modification time changes while its content hash does not
- **THEN** its shard's metadata is updated and its vectors are reused

#### Scenario: A deleted note leaves the corpus

- **WHEN** a note is deleted from the vault
- **THEN** its shard is removed on the next reconcile and no other shard is affected

### Requirement: A vector is a function of path, content and strategy

Because embed text carries path breadcrumbs, the corpus SHALL treat a vector as determined by the note's path, its content and the extraction strategy together. A note recognised as renamed — its content hash matching a shard whose path no longer exists — SHALL have its old shard removed and SHALL be re-embedded under its new path, and two distinct notes with identical content SHALL NOT share vectors. Consequently, a corpus maintained incrementally SHALL be identical to one built from scratch for the same vault state.

#### Scenario: A renamed note is re-embedded

- **WHEN** a note is moved to a different folder without editing its content
- **THEN** the shard at its old path is gone, a shard exists at its new path, and its vectors differ from the ones stored before the move

#### Scenario: Incremental and from-scratch corpora agree

- **WHEN** a vault is indexed from scratch, and separately reached through a sequence of incremental reconciles over edits, renames and deletions ending in the same vault state
- **THEN** both corpora contain the same shards with the same vectors

#### Scenario: Identical content at two paths gets two distinct vectors

- **WHEN** a note is copied to a second path and both are indexed
- **THEN** each shard holds vectors computed from its own path's breadcrumbs

### Requirement: Indexing reports progress and contains per-note failure

Indexing SHALL report progress as a count of notes processed against the total number of notes in scope, and SHALL return a summary distinguishing notes embedded, reused, renamed, deleted and failed. A note's inputs MAY be embedded together in batches, but a batch SHALL contain inputs of one note only, so that a failure to read, embed or store one note is recorded in that summary as that note's failure alone, leaves that note's previously stored shard untouched, and does not abort the run. When reconcile rebuilds a corpus because its manifest did not match, it SHALL report the stored identity it replaced to its caller.

#### Scenario: One unreadable note does not stop the index

- **WHEN** one note fails to embed during a full index of many notes
- **THEN** every other note is indexed, the run completes, and the summary reports exactly one failure

#### Scenario: A failed batch fails only its own note

- **WHEN** the embedding of one batch of a note's block inputs fails during a full index
- **THEN** that note is counted as failed and keeps its previous shard, and no other note is counted as failed because of it

#### Scenario: Progress counts notes against the in-scope total

- **WHEN** a full index is under way
- **THEN** each progress report names how many notes have been processed and how many are in scope, and the final report has the two equal

### Requirement: A single-corpus layout is migrated into its model's directory without re-embedding

On a reconcile pass, while holding the vault's reconcile lock and before comparing the manifest, the indexer SHALL migrate a corpus stored in the pre-per-model layout — a `manifest.json` and a `notes/` directory directly under `<vault>/.neuro-vault/corpus/` — into `<vault>/.neuro-vault/corpus/<model_key>/`, where `<model_key>` is the key that legacy manifest records. Migration SHALL move the entries by rename and SHALL NOT copy or re-embed them, and SHALL rename `notes/` before `manifest.json` so an interrupted migration completes on the next pass. Migration SHALL NOT take place when the target model directory already has a manifest of its own, and SHALL NOT take place when the legacy manifest cannot be read, fails manifest validation, or records a model key that is not a valid model directory name; in those cases the legacy entries SHALL be left in place and the active model's directory SHALL be used as found. A successful migration SHALL be reported with one line on stderr naming the model key.

#### Scenario: A legacy corpus is moved and reused

- **WHEN** a vault whose corpus is a root-level `manifest.json` recording `harrier-270m` plus `notes/` is reconciled with the `harrier-270m` profile and no note changed
- **THEN** the manifest and every shard are now under `.neuro-vault/corpus/harrier-270m/`, no root-level `manifest.json` or `notes/` remains, the pass embeds nothing, and the summary reports every note reused

#### Scenario: A legacy corpus of another model is moved aside

- **WHEN** a vault whose root-level manifest records `bge-micro-v2` is reconciled with the `harrier-270m` profile
- **THEN** the legacy corpus is moved under `.neuro-vault/corpus/bge-micro-v2/` unchanged, and `harrier-270m/` is built without discarding it

#### Scenario: An interrupted migration completes

- **WHEN** a pass finds `.neuro-vault/corpus/harrier-270m/notes/` present without a manifest and a root-level `manifest.json` recording `harrier-270m`
- **THEN** the root manifest is moved into `harrier-270m/` and the pass reuses the shards already there

#### Scenario: A migrated target is not overwritten

- **WHEN** a root-level `manifest.json` recording `harrier-270m` exists and `.neuro-vault/corpus/harrier-270m/manifest.json` also exists
- **THEN** nothing is moved, and the root-level entries are left in place

#### Scenario: An unreadable legacy manifest is left alone

- **WHEN** the root-level `manifest.json` is not valid JSON
- **THEN** nothing is moved or deleted, and the pass builds the active model's corpus in its own directory

#### Scenario: A legacy manifest naming a reserved entry is left alone

- **WHEN** the root-level manifest records the model key `reconcile.lock`, `manifest.json` or `Notes`
- **THEN** nothing is moved, the pass completes normally, and later passes do too

#### Scenario: A manifest-only legacy corpus is moved

- **WHEN** the root-level `manifest.json` records `harrier-270m` and there is no root-level `notes/`
- **THEN** the manifest is moved into `.neuro-vault/corpus/harrier-270m/` and the pass completes normally

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

