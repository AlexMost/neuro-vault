# shared-wikilink-graph Specification

## Purpose
The vault entry's one wikilink graph per vault directory, shared by every attached session and the lexical tie-break: the `graph.noteLinks`, `graph.backlinkCounts` and `graph.resolve` reads with `NOT_ATTACHED` / `GRAPH_FAILED`; the session's graph reader (a view over the vault client, or the session's own graph under `--no-semantic`); one batched graph call per scan for every tool; and the graph's TTL freshness. Rationale: ADR-0020; mechanism: `docs/architecture/wikilink-graph.md`.
## Requirements
### Requirement: Each vault entry holds the vault's one wikilink graph
Each vault entry SHALL hold one wikilink graph over the entry's own scoped reader, and that one graph SHALL answer both the lexical leg's backlink tie-break and every `graph.*` method for every connection attached to the vault. The graph SHALL be created with the entry, warmed in the background when the entry is created, rebuilt from scratch when the entry's scope changes, and dropped with the entry; it SHALL have no idle timer of its own. An entry attached with `profiles: []`, or whose vault sets `"semantic": false`, SHALL hold it too. The same module SHALL serve the in-process fallback of a session.

#### Scenario: Two sessions, one graph
- **WHEN** two sessions attach one vault and each reads backlink counts
- **THEN** both are answered from the same build of the entry's graph, and neither session process reads a note to build a graph

#### Scenario: The tie-break and the reads agree
- **WHEN** a `search_notes` call ranks its lexical leg and stamps each match's `backlink_count`
- **THEN** the tie-break and the stamped counts come from the same graph over the same scope

#### Scenario: A scope change reaches every reader
- **WHEN** an attach finds the vault's ignore patterns changed and the entry rescopes
- **THEN** the entry's graph is rebuilt over the new scope, and every later graph read and tie-break by any attached session answers from it

---

### Requirement: The daemon serves graph reads in batches
The daemon SHALL serve `graph.noteLinks { vault, path }` answering `{ incoming: [{ source }], outgoing: [{ target, resolved, path? }] }`, `graph.backlinkCounts { vault, paths }` answering `{ counts }` with one count per path in order, and `graph.resolve { vault, targets }` answering `{ paths }` with one vault path or `null` per normalized target in order — `vault` the realpath key `vault.attach` returned, and nothing else in the params. A note the graph does not hold SHALL have no links and a count of 0; empty `paths` or `targets` SHALL be answered with empty lists. The calls SHALL carry no profile: a call for a vault this connection did not attach, with any profile list including an empty one, SHALL be answered `NOT_ATTACHED`; malformed params `INVALID_PARAMS`; a failure while building or reading the graph `GRAPH_FAILED` with the reason. Each call SHALL answer from a build at most the graph's TTL old, waiting for a rebuild when the last one is older. The session SHALL wait at most 30 seconds for an answer.

#### Scenario: Counts in the order asked
- **WHEN** a session asks `graph.backlinkCounts` for `["b.md", "missing.md", "a.md"]`, where `a.md` has two incoming links and `b.md` one
- **THEN** it receives `{ counts: [1, 0, 2] }`

#### Scenario: Resolution in the order asked
- **WHEN** a session asks `graph.resolve` for `["Alpha", "Nowhere"]` in a vault whose only `Alpha` note is `notes/Alpha.md`
- **THEN** it receives `{ paths: ["notes/Alpha.md", null] }`

#### Scenario: An attach with no profiles may read the graph
- **WHEN** a connection attached a vault with `profiles: []` and calls `graph.noteLinks`
- **THEN** the call is answered, not refused

#### Scenario: An unattached vault is refused
- **WHEN** a connection calls `graph.backlinkCounts` for a vault it did not attach
- **THEN** it receives a JSON-RPC error with `data.code` `NOT_ATTACHED`

#### Scenario: Both sides validate alike
- **WHEN** a session sends `graph.resolve` with an extra param, over the socket or over the in-process loopback
- **THEN** both answer `INVALID_PARAMS` naming the param

---

### Requirement: A session reads each vault's graph through one graph reader
A session SHALL read each vault's wikilink graph only through that vault's graph reader, which SHALL expose `noteLinks(path)`, `backlinkCounts(paths)` and `resolve(targets)`, each answering from the host's graph with no freshness call of the caller's. With the shared daemon, or under `--no-shared`, or once the process's switch went `local`, the reader SHALL be a view over the vault's one vault client, using the same attach as the vault's other readers. Under `--no-semantic` it SHALL read a graph the session builds over its own reader, with the same implementation the vault entry uses, and that session SHALL start no daemon; the standalone lexical reader SHALL use that same graph for its tie-break. Outside `--no-semantic` the session SHALL build no wikilink graph. Every failure of a view's read (`GRAPH_FAILED`, `NOT_ATTACHED`, `VAULT_UNAVAILABLE`, a timeout, a dropped connection, closed services, or an answer of the wrong shape) SHALL fail that read only, SHALL NOT switch the process to the in-process fallback, and on `NOT_ATTACHED` SHALL forget the attach so the next call attaches again.

#### Scenario: One attach for every reader of a vault
- **WHEN** a session's first call on a new daemon connection is `get_note_links`, followed by `search_notes` on the same vault
- **THEN** the session sends exactly one `vault.attach` for that vault on that connection, and the graph and lexical calls carry the key it answered

#### Scenario: No daemon under --no-semantic
- **WHEN** a `--no-semantic` session answers `get_note_links` and `search_notes`
- **THEN** it starts no daemon, and both answer from the graph the session built

#### Scenario: A dropped connection fails one read
- **WHEN** the daemon connection drops while `graph.backlinkCounts` is in flight
- **THEN** that read fails, the process keeps using the daemon, and the next read reconnects

---

### Requirement: Each tool reads the graph in batches
Each tool and resource SHALL ask the graph reader at most once per question it needs answered, never once per note: `get_note_links` one `noteLinks`; `get_vault_overview` and `vault://overview` one `backlinkCounts` over the scanned paths; `query_notes` and `read_daily` one `backlinkCounts` per scanned path prefix; `search_notes` one `backlinkCounts` over its matches, and none when it has no match; `get_similar_notes` one `resolve` over the query note's link targets. Note filters (`listMatchingPaths`) SHALL NOT read the graph. For the same vault state each tool's output SHALL be what it was when the session held its own graph.

#### Scenario: search_notes stamps every match from one call
- **WHEN** `search_notes` returns twenty matches
- **THEN** the session made one `graph.backlinkCounts` call carrying those twenty paths, and each match's `backlink_count` is that path's count

#### Scenario: query_notes counts before filtering
- **WHEN** `query_notes` runs a filter on `backlink_count` over a vault with one path prefix
- **THEN** the session made one `graph.backlinkCounts` call over that prefix's scanned paths, before evaluating the filter

#### Scenario: A filter reads no graph
- **WHEN** `search_notes` runs with `filter: { tags: ["x"] }`
- **THEN** computing the filter's note set makes no graph call

---

### Requirement: Graph freshness is the TTL, owned by the host
The graph SHALL rebuild on a TTL of three minutes, when a read or a lexical search finds the last build older, with concurrent reads sharing one rebuild; every answer SHALL come from a build at most that old. A session SHALL NOT keep or refresh a graph of its own outside `--no-semantic`. After a scope change, graph answers SHALL follow the vault entry's current scope, as the lexical leg does, while the session's own scans keep the scope it read at startup.

#### Scenario: A later session reads the shared build
- **WHEN** one session reads the graph, a note gains a link on disk, and a second session attaching the same vault reads its backlink count within the TTL
- **THEN** the second session sees the count of the first session's build, not the new link

#### Scenario: A stale build rebuilds on read
- **WHEN** a graph read arrives more than three minutes after the last build
- **THEN** the read waits for a rebuild and answers from it

### Requirement: A failed graph read is a dependency error
A graph read that fails SHALL fail that vault's tool call or resource read with `DEPENDENCY_ERROR`, the message `Graph read failed`, and `details: { vault, operation }`, for `search_notes`, `get_note_links`, `get_vault_overview`, `query_notes`, `read_daily`, `get_similar_notes` and the `vault://overview` resources. The read fails because the view could not answer, or because the session's own graph failed to build under `--no-semantic`. `operation` SHALL be the tool's name, or the resource's URI for a resource read. A tool call SHALL carry the code and details in its tool error envelope, and a resource read SHALL carry them in the JSON-RPC error's `data`. For a single-vault target the whole call SHALL fail. In a fan-out the vault SHALL appear in `failed_vaults` with that code, message and details, and the other vaults SHALL still answer. The failure's cause SHALL be written to stderr and SHALL NOT appear in the response. Under `--no-semantic`, the session's graph reader SHALL surface every failure as a `GraphReadError`. An error that is not a graph read failure SHALL propagate unchanged.

#### Scenario: A single-vault call fails with DEPENDENCY_ERROR

- **WHEN** `get_note_links` runs against a vault whose graph read fails with a timeout
- **THEN** the call fails with `DEPENDENCY_ERROR`, message `Graph read failed`, `details: { vault, operation: "get_note_links" }`, the timeout's message is written to stderr, and it does not appear in the response

#### Scenario: A fan-out lists the vault in failed_vaults

- **WHEN** `search_notes` fans out over two vaults, and one vault's backlink read fails
- **THEN** the other vault's matches are in `results_by_vault`, and the failing vault is in `failed_vaults` with code `DEPENDENCY_ERROR`, message `Graph read failed` and `details: { vault, operation: "search_notes" }`

#### Scenario: Every tool maps the failure

- **WHEN** a graph read fails during `get_vault_overview`, `query_notes`, `read_daily` or `get_similar_notes`
- **THEN** that call fails with `DEPENDENCY_ERROR` and message `Graph read failed`, with `operation` naming the tool

#### Scenario: The overview resource reports the code and hides the cause

- **WHEN** a graph read fails during a `vault://overview` resource read
- **THEN** the read fails with the JSON-RPC error message `Graph read failed` and `data: { code: "DEPENDENCY_ERROR", details: { vault, operation: "vault://overview" } }`, and the cause is written to stderr only

#### Scenario: A failed no-semantic build is a graph read failure

- **WHEN** the server runs with `--no-semantic` and the session's graph build throws
- **THEN** the graph reader rejects with a `GraphReadError` carrying the build's error as its cause

#### Scenario: Other errors pass through

- **WHEN** a graph read rejects with an error that is not a `GraphReadError`
- **THEN** the tool reports that error as before, not as `DEPENDENCY_ERROR`

