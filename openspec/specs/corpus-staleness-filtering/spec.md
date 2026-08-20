# corpus-staleness-filtering Specification

## Purpose

A path from the Smart Connections corpus is a claim about the embedding index, never a promise about the filesystem: the corpus is read-only and unwatched, so it can still name a note deleted since the plugin last wrote its index. This capability covers the guarantee that no such path reaches a client — which tools it binds, where the check sits relative to caller-supplied filtering, and the single per-vault adapter that delivers it.

Mechanism lives in [docs/architecture/smart-connections-corpus.md](../../../docs/architecture/smart-connections-corpus.md#stale-paths); the read-only decision this compensates for is [ADR-0006](../../../docs/adr/0006-smart-connections-corpus.md).

## Requirements
### Requirement: No corpus-derived path reaches a client unless it exists on disk

Every tool that derives note paths from the Smart Connections corpus SHALL verify, at request time, that each path it is about to return still resolves to a file under the vault root, and SHALL drop those that do not. This binds `search_notes` (semantic seeds and their expansion targets), `find_duplicates` (both members of every pair), and `get_similar_notes` (every candidate, whether it arrived by embedding similarity or by forward link). The corpus is read-only and is not watched, so it can name notes deleted since the plugin last wrote its index; without this check a client receives paths it cannot open.

#### Scenario: a deleted note is dropped from search results

- **WHEN** the corpus names a note that no longer exists on disk and `search_notes` retrieves it as a semantic hit
- **THEN** the note is absent from the response, and its absence does not remove any other hit

#### Scenario: a deleted expansion target is dropped

- **WHEN** a surviving semantic seed lists a `related[]` entry whose path no longer exists on disk
- **THEN** that entry is absent from the seed's `related[]` and from the expansion candidates that feed fusion, while the seed itself is returned

#### Scenario: a duplicate pair with one missing member is dropped whole

- **WHEN** `find_duplicates` produces a pair whose `note_a` exists on disk and whose `note_b` does not
- **THEN** the pair is absent from the response

#### Scenario: a deleted forward-linked note is dropped

- **WHEN** `get_similar_notes` collects a candidate that is reached only by a forward wikilink and whose path no longer exists on disk
- **THEN** that candidate is absent from the response

#### Scenario: lexical results are not double-checked

- **WHEN** `search_notes` runs its lexical leg, which reads note content from disk during the same request
- **THEN** lexical-only matches are returned without a separate existence check, because reading them proved their existence

---

### Requirement: One per-vault adapter owns the existence check

The existence check SHALL be implemented exactly once and exposed as a capability of the vault entry, so that a tool obtains it from the entry it already holds rather than reaching for the filesystem itself. Every consumer named in this capability SHALL call that adapter; no consumer SHALL carry its own path-existence implementation. The adapter SHALL be supplied through the same dependency-factory mechanism as the vault entry's other per-vault capabilities, so that a test can substitute it without provisioning files on disk.

#### Scenario: a new corpus-reading tool inherits the guarantee

- **WHEN** a tool handler holds a vault entry and needs to return corpus-derived paths
- **THEN** the existence filter is reachable as a method on that entry, requiring no vault-root threading and no new filesystem code

#### Scenario: the check is substitutable in tests

- **WHEN** a test needs a specific set of paths to count as missing
- **THEN** it supplies a substitute filter through the vault entry, and the tool under test behaves as though those paths were deleted, with no temporary directory created

#### Scenario: exactly one implementation exists

- **WHEN** the source tree is searched for path-existence filtering of corpus results
- **THEN** exactly one implementation is found, and deleting it makes the requirement above unimplementable rather than merely relocating it

---

### Requirement: The filter reports survivors, deduplicates input, and treats each path independently

The adapter SHALL accept an arbitrary iterable of vault-relative note paths and report which of them exist, so that a caller may test one path, both members of a pair, or a candidate list against a single result. Repeated paths in the input SHALL be checked once. Each path SHALL be evaluated independently: a path that does not exist SHALL be reported as absent rather than raising, and SHALL NOT affect the verdict for any other path. An empty input SHALL yield an empty result without touching the filesystem.

#### Scenario: duplicate input paths are checked once

- **WHEN** the same path appears several times in the input
- **THEN** the filesystem is consulted once for it, and it appears at most once in the result

#### Scenario: a missing path does not raise

- **WHEN** the input contains a path with no file behind it
- **THEN** the call resolves normally, reporting that path as absent and every existing path as present

#### Scenario: paths are resolved against this vault's root

- **WHEN** two registered vaults hold notes at the same vault-relative path and only one of them has the file
- **THEN** each vault's adapter reports the verdict for its own root, independently of the other

---

### Requirement: Caller-supplied filtering composes with the existence check without changing results

Where a tool applies its own filtering to corpus-derived candidates, that filtering and the existence check SHALL both apply, and the returned set SHALL be exactly the candidates that satisfy both. `get_similar_notes` SHALL continue to honour `exclude_folders`, and the observable result of combining exclusion with the existence check SHALL be independent of the order in which the two are applied.

#### Scenario: an excluded folder still excludes existing notes

- **WHEN** `get_similar_notes` is called with `exclude_folders` covering a folder that contains an existing, similar note
- **THEN** that note is absent from the response

#### Scenario: exclusion and staleness are independent

- **WHEN** a candidate is both inside an excluded folder and missing from disk
- **THEN** it is absent from the response, and no error is raised for the missing file

