## MODIFIED Requirements

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
