# shared-corpus-reads Specification

## Purpose
How a session reads a vault's corpus without holding its vectors: the daemon's `corpus.nearest` / `corpus.nearestBlocks` reads over a vault entry's corpus (path or vector anchors, `allowed` / `exclude`, `CORPUS_NOT_READY` / `CORPUS_FAILED`), the session's one semantic-backend facade with an asynchronous status, background attach at startup, reconnect after a daemon dies, and the semantic leg, `get_similar_notes` and `find_duplicates` composed in the session over those reads with unchanged ranking. Rationale: ADR-0019, ADR-0020; mechanism: `docs/architecture/semantic-backend.md`, `docs/architecture/retrieval-policy.md`.
## Requirements
### Requirement: corpus.nearest and corpus.nearestBlocks serve the corpus's reads

The daemon SHALL serve `corpus.nearest { vault, profile, anchors, threshold, limit?, allowed?, exclude? }` answering `{ hits: ({ path, similarity }[] | null)[] }`, and `corpus.nearestBlocks { vault, profile, anchors, paths, threshold, limit? }` answering `{ hits: ({ path, heading, lines, similarity }[] | null)[] }`, each within 30 seconds. An anchor SHALL be either `{ vector }` or `{ path }`; for a path anchor the corpus SHALL use that note's own vector. `hits` SHALL hold one list per anchor, in order: `null` for a path anchor whose note has no vector, `[]` when nothing reaches the threshold. Results SHALL be ordered by similarity, then by path. `allowed` and `exclude` SHALL restrict note results before `limit` applies. No note or block vector SHALL appear in any answer. A call for a vault and profile this connection did not attach SHALL be answered `NOT_ATTACHED`; a vector anchor whose length is not the corpus's dimension `INVALID_PARAMS`; an unknown profile `UNKNOWN_PROFILE`. The daemon SHALL yield to its event loop between the anchors of one call.

#### Scenario: One list per anchor

- **WHEN** a session sends `corpus.nearest` with two query vectors and a path anchor for a note too short to carry a vector
- **THEN** `hits` has three entries: two ranked lists and `null`

#### Scenario: allowed narrows before the limit

- **WHEN** `corpus.nearest` runs with `limit: 3` and `allowed` naming five notes, none of them among the top three overall
- **THEN** the answer holds the best three of those five

#### Scenario: Wrong dimension

- **WHEN** a session sends a 384-dimension vector to a 640-dimension corpus
- **THEN** it receives `INVALID_PARAMS`

#### Scenario: Vectors stay in the daemon

- **WHEN** `get_similar_notes` runs against a vault served by the daemon
- **THEN** no message on the session's connection carries a note vector

---

### Requirement: A corpus read on a corpus that cannot serve says why

A corpus read while the profile is not `ready` SHALL be answered `CORPUS_NOT_READY` with the profile's `BackendStatus` in `data.status`. A read that fails inside the corpus SHALL be answered `CORPUS_FAILED` with the reason.

#### Scenario: A read during the cold build

- **WHEN** a session sends `corpus.nearest` for a profile that is still building its first corpus
- **THEN** it receives `CORPUS_NOT_READY` whose `data.status` is `{ state: "indexing", indexed, total }`

---

### Requirement: The session reads the corpus through one facade and holds no vector

A session SHALL reach each vault's corpus only through its semantic backend, which SHALL expose `nearest`, `nearestBlocks`, an asynchronous `status()` and `dispose()`, and SHALL NOT expose the corpus's vectors. With the shared daemon the backend SHALL use `vault.status` and `corpus.*`; in the in-process fallback it SHALL run the same vault-entry module inside the session. The backend SHALL read the status once per semantic tool call. A `vault.status` that times out SHALL read as `unavailable` for that call only. `CORPUS_NOT_READY` SHALL be reported like the readiness gate reports the same state; `CORPUS_FAILED` and `NOT_ATTACHED` SHALL be reported as `DEPENDENCY_ERROR`.

#### Scenario: No snapshot in the session

- **WHEN** a session using the daemon has served `search_notes`, `get_similar_notes` and `find_duplicates` against a ready vault
- **THEN** the session process holds no decoded corpus, watcher or reconcile loop for that vault

#### Scenario: A status timeout degrades one search

- **WHEN** the daemon does not answer `vault.status` within 10 seconds during a hybrid `search_notes`
- **THEN** that call returns lexical matches with `semantic_status.state` `unavailable`, and the next call asks again

---

### Requirement: Sessions attach every vault in the background at startup

At startup a session SHALL attach every semantically enabled vault with its profile, in the background, without delaying the MCP handshake; while the `vault.attach` request is in flight the vault's status SHALL read `{ state: "indexing", indexed: 0, total: 0 }`, and a call that arrives while the daemon is still being located or started SHALL wait for that first. A session SHALL re-send `vault.attach` for each vault once per connection to the daemon before its first call on that connection.

#### Scenario: A reconnect re-attaches

- **WHEN** the daemon idled out while a session stayed open and the session then runs `search_notes`
- **THEN** the session reconnects, attaches the vault again before any corpus read, and the search succeeds once the entry is ready

---

### Requirement: A daemon that dies mid-session is reconnected, not replaced

When the connection to the daemon closes, the call in flight SHALL fail and the next call SHALL reconnect, spawning the daemon if needed; a request that times out SHALL fail that call only, and the connection SHALL stay up. The session SHALL NOT build an in-process watcher, reconcile loop or corpus because a connection dropped. It SHALL switch to the in-process vault entry only on the same condition, and through the same one-way switch, as the embedding provider: when the daemon cannot be located or started.

#### Scenario: Killed daemon

- **WHEN** the daemon is killed while a session is open and the session then runs two semantic calls
- **THEN** the first fails or degrades to lexical, the second reaches a respawned daemon, and the session never holds a corpus of its own

---

### Requirement: The semantic leg is composed in the session and ranks as before

`search_notes`' semantic leg SHALL be composed in the session from `embed.query` and the corpus reads: per-query seeds with `limit + 1`, the fallback threshold for a query left empty under a default threshold, blocks within the seeds, a best-block backfill for each seed left without blocks, and expansion from each seed with the seeds excluded, all restricted by the search's `allowed` set. For the same corpus, queries, effort and overrides, it SHALL return the same seeds, similarities, blocks, related notes, `truncated`, `per_query_hits` and `per_query_fallback` as the in-memory composition it replaces. Every query of a search SHALL be sent in one corpus call per step.

#### Scenario: Parity with the in-memory leg

- **WHEN** the composed leg and the previous in-memory leg run over the same fixture corpus for `quick` and `deep`, with and without a filter
- **THEN** their outputs are identical

#### Scenario: One call per step for several queries

- **WHEN** `search_notes` runs three queries in `deep`
- **THEN** the seeds of all three come from one `corpus.nearest` call

---

### Requirement: get_similar_notes and find_duplicates compose over the corpus reads

`get_similar_notes` SHALL find semantic neighbours with one `nearest` read anchored on the note's path, excluding the note itself and bounded by the threshold only, and SHALL fail with `NOT_FOUND` when that anchor has no vector. It SHALL resolve forward links through a basename index of the vault's scoped note list, so a linked note too short to carry a vector SHALL be reported with `forward_link`. `find_duplicates` SHALL send the vault's scoped note paths as path anchors in batches of at most 64, skip anchors without a vector, report each pair once with `note_a` before `note_b`, and order pairs by similarity, then `note_a`, then `note_b`.

#### Scenario: A link to a short note

- **WHEN** a note links to a note below the embedding size gate
- **THEN** `get_similar_notes` on the first note reports the short note with `signals.forward_link: true`

#### Scenario: Duplicates are reported once

- **WHEN** two notes are near-identical
- **THEN** `find_duplicates` reports one pair for them, not two

