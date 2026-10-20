# shared-lexical-search Specification

## Purpose
The lexical leg of `search_notes` served from the vault entry: one read-through lexical cache per vault directory, tie-broken by the vault entry's one wikilink graph (the shared-wikilink-graph capability), warmed in the background and refreshed serially without evicting on `allowed`; the daemon's `lexical.search` with `NOT_ATTACHED` / `LEXICAL_FAILED`; the session's one lexical reader (daemon, in-process entry, or standalone under `--no-semantic`) and its error mapping; and the cache's line in `daemon status`. Rationale: ADR-0020; mechanism: `docs/architecture/lexical-search.md`.
## Requirements
### Requirement: Each vault entry holds one lexical cache and one tie-break graph

Each vault entry SHALL hold one lexical cache (parsed titles, headings and body blocks of every note in the entry's scope, keyed by path with the note's mtime) over the entry's own scoped reader, created with the entry, warmed in the background when the entry is created and again after a scope change, and dropped with the entry, and lexical ranking's backlink tie-break SHALL read the entry's one wikilink graph (the shared-wikilink-graph capability), the same graph every attached session reads. Neither SHALL have an idle timer of its own. An entry attached with `profiles: []`, or whose vault sets `"semantic": false`, SHALL hold them too. The same module SHALL serve the in-process fallback of a session.

#### Scenario: N sessions, one cache

- **WHEN** three sessions attach one vault and each runs `search_notes` in `mode: "lexical"`
- **THEN** the daemon holds one lexical cache and one graph for that vault, and no session process parses a note for its lexical leg or builds a wikilink graph for each match's `backlink_count`

#### Scenario: An opted-out vault is served

- **WHEN** a session attaches a vault whose config sets `"semantic": false` with `profiles: []` and runs `search_notes` in `mode: "lexical"`
- **THEN** the daemon answers from that entry's lexical cache, and the entry has no corpus and no watcher

#### Scenario: The cache goes with the entry

- **WHEN** the last connection on a vault closes and the entry's idle timeout fires
- **THEN** its lexical cache and graph are freed with it, and the next attach warms a new one

### Requirement: lexical.search serves the lexical leg over the wire

The daemon SHALL serve `lexical.search { vault, queries, allowed?, note_cap, per_note_cap }` — `vault` the realpath key `vault.attach` returned, `queries` a non-empty list of strings, `allowed` an optional list of vault-relative paths, `note_cap` and `per_note_cap` positive integers, and nothing else — answering `{ notes: [{ path, matches: [{ matched_in, snippet, lines?, heading? }], matched_queries }], truncated, per_query_counts, per_query_token_counts, total_notes }`, with snippets built in the daemon; the session SHALL wait at most 30 seconds for the answer. The ranking, the matching rules, the caps and the evidence SHALL be those of the hybrid-search capability's lexical leg, with the entry's own graph supplying `backlink_count` for the tie-break. The call SHALL carry no profile. A call for a vault this connection did not attach, with any profile list including an empty one, SHALL be answered `NOT_ATTACHED`; malformed params `INVALID_PARAMS`; a failure inside the search `LEXICAL_FAILED` with the reason. There SHALL be no readiness state: a call on a cache that is still warming SHALL wait for the warm.

#### Scenario: Same evidence as in-process

- **WHEN** `lexical.search` and an in-process lexical index run over the same vault files for the query sets phrase, multi-token, accent-folded, apostrophe, multi-query, no-match and title
- **THEN** the `notes`, `truncated`, `per_query_counts`, `per_query_token_counts` and `total_notes` of each pair are identical

#### Scenario: A cold cache waits

- **WHEN** a connection attaches a vault and sends `lexical.search` before the entry's first refresh has finished
- **THEN** the answer arrives after that refresh and ranks over every note in the scope

#### Scenario: Not attached

- **WHEN** connection A attached a vault and connection B, which did not, sends `lexical.search` for it
- **THEN** B receives `NOT_ATTACHED`

#### Scenario: A failing search

- **WHEN** the entry's lexical search throws while ranking
- **THEN** the caller receives `LEXICAL_FAILED` with the reason and the connection stays open

#### Scenario: Closed params

- **WHEN** a client sends `lexical.search` with a `profile` key
- **THEN** it receives `INVALID_PARAMS`

---

### Requirement: The entry's lexical cache is read-through, refreshed serially, and never evicts on allowed

The entry's lexical cache SHALL reflect the disk at call time: each `lexical.search` SHALL be served by a refresh that began after the call arrived, where a refresh scans the scope the cache was built for (a scope change replaces the cache; the next call is served by the new one), drops cached notes the scan no longer lists, stats every scanned note and re-parses those whose mtime changed. Refreshes of one cache SHALL NOT overlap: a call that arrives during a refresh SHALL wait for it and SHALL share one follow-up refresh with every other call that arrived during the same run. `allowed` SHALL narrow the ranked candidates only, after the refresh, and SHALL NOT evict any cached note. `total_notes` SHALL be the number of notes in the entry's scope before `allowed`. The entry's watcher and reconcile loop SHALL NOT touch the cache, and a lexical hit SHALL need no existence check.

#### Scenario: An edit is visible to the next call from any session

- **WHEN** session A edits a note so that its body gains `гібридний тест` and session B then runs `search_notes` with that query on the same vault
- **THEN** B's result contains the note with lexical provenance

#### Scenario: A call during a refresh is served by the next one

- **WHEN** a refresh is in flight when a `lexical.search` arrives
- **THEN** that call is answered by a refresh that started after it arrived, and a third call arriving meanwhile shares that same follow-up refresh

#### Scenario: A filtered call evicts nothing

- **WHEN** a `search_notes` with a `filter` matching ten notes runs, and an unfiltered `search_notes` follows with no file changed
- **THEN** the second call re-parses no note and `total_notes` is the full scoped count on both calls

#### Scenario: A scope change drops notes on the next call

- **WHEN** an attach brings a scope that excludes `Archive/**` and a `lexical.search` follows
- **THEN** no note under `Archive/` is ranked or counted in `total_notes`

#### Scenario: Served through a pass

- **WHEN** a reconcile pass is running on the entry
- **THEN** a `lexical.search` on the same entry is answered without waiting for the pass

---

### Requirement: The session reads the lexical leg through one reader

A session SHALL reach each vault's lexical leg only through that vault's lexical reader, which SHALL expose `search(queries, allowed?, noteCap, perNoteCap)` answering the leg's ranked notes, `truncated`, per-query counts, per-query token counts and `totalNotes`, and `warm()`. With the shared daemon the reader SHALL use `lexical.search` over the process's one connection and the vault's one attachment; under `--no-shared`, or once the process's switch went `local`, it SHALL use the in-process vault entry; under `--no-semantic`, and in the retrieval-eval harness, it SHALL be a standalone in-process lexical index over the session's reader and graph, and such a session SHALL start no daemon. The reader SHALL resolve the backlink tie-break itself; `search_notes` SHALL NOT pass a backlink function to the leg. A lexical failure (`LEXICAL_FAILED`, a timeout, a dropped connection, `NOT_ATTACHED`, `VAULT_UNAVAILABLE`, or an in-process throw) SHALL fail that vault's search with `DEPENDENCY_ERROR` (the whole `search_notes` call for a single-vault target; its `failed_vaults` entry in a fan-out), SHALL NOT switch the process to the in-process fallback, and on `NOT_ATTACHED` SHALL forget the attach so the next call attaches again.

#### Scenario: One payload whichever reader serves

- **WHEN** `search_notes` runs with the same arguments over the same vault files through the daemon reader, the in-process reader and the standalone reader
- **THEN** the three payloads are identical

#### Scenario: A daemon timeout fails one search

- **WHEN** the daemon does not answer `lexical.search` within 30 seconds
- **THEN** that `search_notes` fails with `DEPENDENCY_ERROR`, the process's switch is unchanged, and the next call goes to the daemon again

#### Scenario: no-semantic stays in-process

- **WHEN** the server runs with `--no-semantic` and serves `search_notes`
- **THEN** the lexical leg is served by the session's own lexical index, and no daemon connection is opened or spawned

#### Scenario: no-shared runs the entry in the session

- **WHEN** the server runs with `--no-shared` and serves `search_notes`
- **THEN** the lexical leg is served by the in-process vault entry's cache, and no daemon connection is opened

#### Scenario: A respawned daemon is attached once for both legs

- **WHEN** the daemon is killed and a hybrid `search_notes` then runs
- **THEN** the session sends one `vault.attach` on the new connection before its first `corpus.*` or `lexical.search` call, and both legs use the key it answered

---

### Requirement: daemon.info reports the lexical cache per entry

`daemon.info` SHALL report, for each vault entry, `lexical: { state, notes?, last_refresh? }` where `state` is `warming` until the cache's first successful refresh, and again after a scope change replaces the cache, and `ready` otherwise, `notes` the number of cached notes once ready, and `last_refresh` the last refresh's time, the number of notes it re-parsed and its duration.

#### Scenario: Warming then ready

- **WHEN** a connection attaches a vault and `daemon.info` is read before and after the entry's first refresh
- **THEN** the first read shows `lexical.state` `warming` and the second `ready` with `notes` equal to the scoped note count

