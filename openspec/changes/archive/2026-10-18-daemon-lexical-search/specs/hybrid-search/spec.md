## MODIFIED Requirements

### Requirement: Lexical corpus freshness without an index

Lexical matching SHALL reflect the vault state at request time: content is re-read per request, with an mtime-keyed cache (`path → { mtime, title, blocks }`) so only changed files are re-parsed. The cache SHALL be held once per vault directory — in the shared daemon's vault entry by default, in the session's in-process vault entry under `--no-shared`, in the session itself under `--no-semantic` — and shared by every session served from it; a request SHALL be served by a refresh that began after it arrived, refreshes of one cache SHALL NOT overlap, and a `filter` SHALL narrow the ranked candidates without evicting any cached note. No persistent search index SHALL be maintained.

#### Scenario: an edit is visible on the next call

- **WHEN** a note body gains the string `грибридний тест` and `search_notes` runs afterwards with that query
- **THEN** the note appears in `matches[]` with lexical provenance, without any server restart or reindex step

#### Scenario: an edit is visible to another session

- **WHEN** one session's client edits a note and a second session on the same vault then runs `search_notes` with a query the edit introduced
- **THEN** the second session's `matches[]` contains the note with lexical provenance

#### Scenario: a filtered search does not slow the next one

- **WHEN** `search_notes` runs with a `filter` and an unfiltered `search_notes` follows with no file changed
- **THEN** the second call re-parses no note

---

### Requirement: Lexical leg is independent of the embedding corpus

The lexical leg SHALL function whatever state the vault's embedding corpus is in — absent, still building, disabled, or unreadable — and `mode: "lexical"` SHALL NOT read a corpus snapshot at all. Semantic-leg failure or emptiness SHALL NOT fail the lexical leg. A failure of the lexical leg itself (the shared daemon's lexical search failed or timed out, the connection dropped during it, or the in-process index threw) SHALL fail that vault's search with `DEPENDENCY_ERROR` (the whole call for a single-vault target; its `failed_vaults` entry in a fan-out) and SHALL NOT switch the process to its in-process fallback; a daemon that cannot be located or started flips the process's one-way switch as for every other facade, and the leg is then served in-process.

#### Scenario: lexical search works without a corpus

- **WHEN** a vault has no embedding corpus yet and `search_notes` is called with `{ query: "пошук", mode: "lexical" }`
- **THEN** the call succeeds and `matches[]` contains lexically-sourced entries with title/heading/body evidence

#### Scenario: lexical search works while the index builds

- **WHEN** a vault is indexing and `search_notes` is called with `{ query: "пошук" }`
- **THEN** the call succeeds with lexical matches and reports `semantic_status: { state: "indexing", indexed, total }`

#### Scenario: a semantic leg that throws keeps the lexical matches

- **WHEN** the semantic leg fails mid-search on a vault whose backend reported `ready` — the query embedding rejects, or the corpus read fails
- **THEN** the call succeeds with the lexical matches it already computed, reports `semantic_status: { state: "unavailable", note }` rather than the `ready` it started from, and writes the cause to stderr

#### Scenario: a lexical leg that fails is a dependency error

- **WHEN** the shared daemon does not answer `lexical.search` within its timeout during `search_notes`
- **THEN** the call fails with `DEPENDENCY_ERROR`, and the next `search_notes` reaches the daemon again
