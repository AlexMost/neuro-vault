# own-corpus-index Specification

## Purpose
The embedding corpus the server builds and owns: where it lives, the shard and manifest schema, atomic writes and crash recovery, membership from the vault scope, and the incremental reconcile that keeps it in agreement with the vault.

## Requirements

### Requirement: The server builds and owns an embedding corpus stored inside the vault

The server SHALL build its own embedding corpus and SHALL store it under `<vault>/.neuro-vault/corpus/`, one directory per vault, so a vault carries its corpus with it. The corpus directory SHALL be a dot-path, and therefore unconditionally excluded from vault scope. This supersedes the earlier decision that the server never writes embeddings; consuming a third-party corpus read-only is no longer the only source of vectors.

#### Scenario: Corpus writes land under the vault's dot-directory

- **WHEN** a vault is indexed
- **THEN** every file the indexer writes is under that vault's `.neuro-vault/corpus/`, and no scope-governed surface reports any of those files

#### Scenario: Each vault gets its own corpus

- **WHEN** two vaults are indexed by the same process
- **THEN** each vault's shards and manifest live under its own root, and neither corpus contains an entry for the other vault's notes

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

The corpus SHALL carry one manifest recording the embedding version, model key, vector dimension, extraction strategy identifier, and creation time, and SHALL write it only when those values change. Reconcile SHALL compare the stored manifest against the running configuration and SHALL discard every shard and rebuild the corpus when they differ or when the manifest is missing or unreadable while shards exist. A change to vault scope or exclusions SHALL NOT trigger a rebuild, since membership is not a property of the vectors.

#### Scenario: A model or strategy change rebuilds the corpus

- **WHEN** the stored manifest names a different model key, dimension, embedding version or extraction strategy than the running configuration
- **THEN** every existing shard is discarded and the corpus is rebuilt from the vault

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

Indexing SHALL report progress as a count of notes processed against the total number of notes in scope, and SHALL return a summary distinguishing notes embedded, reused, renamed, deleted and failed. A failure to read, embed or store one note SHALL be recorded in that summary, SHALL leave that note's previously stored shard untouched, and SHALL NOT abort the run.

#### Scenario: One unreadable note does not stop the index

- **WHEN** one note fails to embed during a full index of many notes
- **THEN** every other note is indexed, the run completes, and the summary reports exactly one failure

#### Scenario: Progress counts notes against the in-scope total

- **WHEN** a full index is under way
- **THEN** each progress report names how many notes have been processed and how many are in scope, and the final report has the two equal
