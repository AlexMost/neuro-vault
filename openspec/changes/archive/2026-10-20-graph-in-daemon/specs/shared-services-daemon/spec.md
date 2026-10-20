## MODIFIED Requirements

### Requirement: The daemon speaks JSON-RPC 2.0 over stdio framing with namespaced methods

Each connection SHALL carry JSON-RPC 2.0 messages, one per line, exactly as the MCP stdio transport frames them. Methods SHALL be named `<service>.<method>`. The daemon SHALL serve `daemon.info` (returning `name`, `version`, `pid`, `started_at`, `idle_timeout_min`, `clients`, and per-service state) and `daemon.shutdown`, and SHALL route any other method to the registered service of its namespace, together with the identity of the connection it arrived on, so a service can keep per-connection state and release it when that connection closes. An unknown namespace or method SHALL receive a JSON-RPC error whose `data.code` is `UNKNOWN_METHOD`; malformed params `INVALID_PARAMS`; a request arriving during shutdown `SHUTTING_DOWN`; a lexical search that fails inside the entry `LEXICAL_FAILED`; a graph read that fails inside the entry `GRAPH_FAILED`. An error MAY carry further fields in `data` beside `code`. A line that is not a valid JSON-RPC message SHALL close that connection and SHALL NOT affect other connections.

#### Scenario: Info over the socket

- **WHEN** a client sends `{"jsonrpc":"2.0","id":1,"method":"daemon.info"}` followed by a newline
- **THEN** it receives one line with `id: 1` and a `result` carrying the package name and version, the daemon pid and the client count

#### Scenario: Unknown method

- **WHEN** a client sends method `watch.subscribe` to a daemon without a `watch` service
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

