## MODIFIED Requirements

### Requirement: No corpus-derived path reaches a client unless it exists on disk

Every tool that derives note paths from the embedding corpus SHALL verify, at request time, that each path it is about to return still resolves to a file under the vault root, and SHALL drop those that do not. This binds `search_notes` (semantic seeds and their expansion targets), `find_duplicates` (both members of every pair), and `get_similar_notes` (every candidate, whether it arrived by embedding similarity or by forward link). The corpus the server owns is kept fresh by a debounced reconcile, not synchronously with the filesystem, so between a deletion and the next pass it can still name a note that is gone; without this check a client receives paths it cannot open.

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

#### Scenario: a note deleted inside the debounce window is still filtered

- **WHEN** a note is deleted and a semantic call arrives before the next reconcile pass has removed its shard
- **THEN** the note does not appear in the response
