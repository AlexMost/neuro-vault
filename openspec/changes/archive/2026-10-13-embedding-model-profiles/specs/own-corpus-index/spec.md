## MODIFIED Requirements

### Requirement: The manifest records corpus identity and gates a rebuild

The corpus SHALL carry one manifest recording everything that produced its vectors — the embedding provider, the model profile key, the model repository id and its pinned revision, the weight dtype, the vector dimension, the pooling method, the maximum input length in tokens, the embedding version, and the extraction strategy identifier — plus its creation time, and SHALL write it only when those values change. The recorded identity SHALL be taken from the active embedding provider, not from constants of the corpus library. Reconcile SHALL compare the stored manifest against the running identity and SHALL discard every shard and rebuild the corpus when any recorded field differs, or when the manifest is missing or unreadable while shards exist. A manifest written by an earlier version that lacks some of these fields SHALL still be read far enough to name the model and embedding version it records, and SHALL be treated as incompatible. A change to vault scope or exclusions SHALL NOT trigger a rebuild, since membership is not a property of the vectors.

#### Scenario: A model or strategy change rebuilds the corpus

- **WHEN** the stored manifest names a different model profile, revision, dimension, pooling method, maximum input length, embedding version or extraction strategy than the running identity
- **THEN** every existing shard is discarded and the corpus is rebuilt from the vault

#### Scenario: A legacy manifest is named, then rebuilt

- **WHEN** reconcile meets a manifest written before this change, recording `bge-micro-v2` at embedding version 1 without provider, revision, dtype, pooling or maximum-length fields
- **THEN** the rebuild proceeds, and the rebuild report names `bge-micro-v2` and embedding version 1 as the identity being replaced

#### Scenario: An exclusion change is not a rebuild

- **WHEN** the vault's exclusion configuration changes so that some notes leave scope and others enter it
- **THEN** the next reconcile deletes the shards of departed notes and embeds the newly included ones, leaving every other shard and the embedding version untouched

---

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
