## MODIFIED Requirements

### Requirement: The daemon speaks JSON-RPC 2.0 over stdio framing with namespaced methods

Each connection SHALL carry JSON-RPC 2.0 messages, one per line, exactly as the MCP stdio transport frames them. Methods SHALL be named `<service>.<method>`. The daemon SHALL serve `daemon.info` (returning `name`, `version`, `pid`, `started_at`, `idle_timeout_min`, `clients`, and per-service state) and `daemon.shutdown`, and SHALL route any other method to the registered service of its namespace, together with the identity of the connection it arrived on, so a service can keep per-connection state and release it when that connection closes. An unknown namespace or method SHALL receive a JSON-RPC error whose `data.code` is `UNKNOWN_METHOD`; malformed params `INVALID_PARAMS`; a request arriving during shutdown `SHUTTING_DOWN`; a lexical search that fails inside the entry `LEXICAL_FAILED`. An error MAY carry further fields in `data` beside `code`. A line that is not a valid JSON-RPC message SHALL close that connection and SHALL NOT affect other connections.

#### Scenario: Info over the socket

- **WHEN** a client sends `{"jsonrpc":"2.0","id":1,"method":"daemon.info"}` followed by a newline
- **THEN** it receives one line with `id: 1` and a `result` carrying the package name and version, the daemon pid and the client count

#### Scenario: Unknown method

- **WHEN** a client sends method `graph.links` to a daemon without a `graph` service
- **THEN** it receives a JSON-RPC error with `data.code` `UNKNOWN_METHOD` and the connection stays open

#### Scenario: A bad line isolates one client

- **WHEN** one client sends a line that is not JSON
- **THEN** that client's connection is closed and another client's in-flight request completes normally

#### Scenario: A later service is one registry entry

- **WHEN** a service registered under namespace `watch` exposes method `subscribe`
- **THEN** `watch.subscribe` is routed to it with no change to framing, discovery or lifecycle

#### Scenario: A service hears its connection close

- **WHEN** a connection that attached a vault closes
- **THEN** the `vault` service is told which connection closed and detaches it

#### Scenario: Error data beyond the code

- **WHEN** a corpus read is refused because the corpus is still indexing
- **THEN** the error's `data` carries `code: "CORPUS_NOT_READY"` and the profile's `status`

#### Scenario: A lexical call makes a client

- **WHEN** a connection's first request outside the `daemon.` namespace is `lexical.search`
- **THEN** the daemon counts it as a client, as it does for `embed.*` and `vault.*`

---

### Requirement: daemon status and daemon stop are the operator surface

`daemon status` SHALL read every `daemons/*/daemon.json`, probe each socket, call `daemon.info` on those that answer, print one line per daemon with version, pid, client count, loaded profiles and `alive`, followed by one line per vault entry (its path, and its client count or how long it has been idle), one line for that entry's lexical cache (`warming`, or `ready` with its note count and its last refresh's time, re-parsed count and duration) and one line per profile of that entry (its state, its note count or `indexed/total`, and its last reconcile's added, changed and removed counts and duration), and SHALL remove the state directory of every entry whose socket refuses the connection or is absent, printing it as `stale`; an entry whose socket accepts the connection but does not answer `daemon.info` in time SHALL be printed as `busy` and kept, and an entry whose lock names another live process SHALL be left alone and reported as `starting`, by `stop` as well. An entry SHALL be removed only after `status` has taken over its lock, so a daemon that takes the lock meanwhile keeps its state. An unreadable `daemon.json`, or a lock with no `daemon.json` whose holder is dead, SHALL be treated as stale. `daemon stop` SHALL call `daemon.shutdown` on every alive daemon, falling back to `SIGTERM` when the call does not complete, and SHALL exit `0`. Both SHALL exit `0` when no daemon is known.

#### Scenario: Status lists live and stale daemons

- **WHEN** one daemon is alive and another's info file points at a dead socket
- **THEN** `status` prints the live one as `alive` with its version, pid, clients and loaded profiles, prints the other as `stale`, and removes the stale entry

#### Scenario: Status lists vault entries

- **WHEN** a live daemon holds one vault entry with two attached sessions, a warm lexical cache of 955 notes and a `ready` `harrier-270m` corpus of 955 notes
- **THEN** under the daemon line `status` prints the vault's path with `clients 2`, a `lexical` line with `ready`, `955` notes and its last refresh, and a line for `harrier-270m` with `ready`, `955` notes and its last reconcile

#### Scenario: A daemon without a lexical cache

- **WHEN** a daemon of a build before this change answers `daemon.info` without `lexical` on its vault entries
- **THEN** `status` prints its vault and profile lines and no lexical line

#### Scenario: Stop ends every daemon

- **WHEN** `daemon stop` runs with two live daemons of different versions
- **THEN** both stop and a following `status` reports none
