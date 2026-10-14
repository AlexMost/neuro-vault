## ADDED Requirements

### Requirement: The daemon command runs one shared-services process per installed version

The CLI SHALL provide a `daemon` command that starts a shared-services process listening on a local socket whose path is derived from the installed package version: on POSIX `/tmp/neuro-vault-<uid>/<key>.sock` with the directory created mode `0700` and the socket file set to `0600`; on Windows `\\.\pipe\neuro-vault-<uid>-<key>`; where `<key>` is a 12-hex-character hash of the version. The POSIX path MUST be shorter than 100 bytes. The process SHALL keep its state under `<cache>/neuro-vault/daemons/<key>/` — `daemon.json`, `daemon.log`, `daemon.lock` — where `<cache>` is `$XDG_CACHE_HOME` when that is an absolute path and `~/.cache` otherwise. The command SHALL accept `--idle-timeout <minutes>` (default `30`; `0` means never) and no vault or model option, and SHALL load no model until a client asks for one.

#### Scenario: Socket path is version-keyed and short

- **WHEN** `daemon` starts for package version `18.0.0` as uid `501` on macOS
- **THEN** it listens on `/tmp/neuro-vault-501/<12 hex>.sock`, the directory is mode `0700`, the socket file is mode `0600`, and the path is under 100 bytes

#### Scenario: Two versions, two daemons

- **WHEN** a daemon of version `18.0.0` is running and a `daemon` of version `18.1.0` starts
- **THEN** the second listens on a different socket path and both run

#### Scenario: Startup loads no model

- **WHEN** `daemon` has started and no client has connected
- **THEN** no embedding model is loaded

---

### Requirement: Stale state is cleaned under a lock; a live daemon is never displaced

Before listening, `daemon` SHALL create `daemon.lock` exclusively, writing its pid. When the lock exists, the pid in it SHALL be checked for liveness: alive → the new process exits non-zero saying a daemon is already running; dead → the lock is replaced. On POSIX, an existing socket file SHALL then be probed with a connection attempt: refused or absent → the file is unlinked; connected → the new process exits non-zero. File size or age SHALL NOT be used as evidence of staleness.

#### Scenario: Crash leftovers are cleaned

- **WHEN** a previous daemon crashed leaving `daemon.lock` with a dead pid and a socket file nobody listens on
- **THEN** the next `daemon` replaces the lock, unlinks the socket file, and listens

#### Scenario: A live daemon wins the race

- **WHEN** two `daemon` processes start at the same time for the same version
- **THEN** exactly one listens, the other exits non-zero without touching the winner's socket or lock, and a client connecting during the race reaches the winner

#### Scenario: Live lock holder

- **WHEN** `daemon` starts while `daemon.lock` names a live pid
- **THEN** it exits non-zero naming that pid

---

### Requirement: The daemon speaks JSON-RPC 2.0 over stdio framing with namespaced methods

Each connection SHALL carry JSON-RPC 2.0 messages, one per line, exactly as the MCP stdio transport frames them. Methods SHALL be named `<service>.<method>`. The daemon SHALL serve `daemon.info` (returning `name`, `version`, `pid`, `started_at`, `idle_timeout_min`, `clients`, and per-service state) and `daemon.shutdown`, and SHALL route any other method to the registered service of its namespace. An unknown namespace or method SHALL receive a JSON-RPC error whose `data.code` is `UNKNOWN_METHOD`; malformed params `INVALID_PARAMS`; a request arriving during shutdown `SHUTTING_DOWN`. A line that is not a valid JSON-RPC message SHALL close that connection and SHALL NOT affect other connections.

#### Scenario: Info over the socket

- **WHEN** a client sends `{"jsonrpc":"2.0","id":1,"method":"daemon.info"}` followed by a newline
- **THEN** it receives one line with `id: 1` and a `result` carrying the package name and version, the daemon pid and the client count

#### Scenario: Unknown method

- **WHEN** a client sends method `lexical.search` to a daemon without a `lexical` service
- **THEN** it receives a JSON-RPC error with `data.code` `UNKNOWN_METHOD` and the connection stays open

#### Scenario: A bad line isolates one client

- **WHEN** one client sends a line that is not JSON
- **THEN** that client's connection is closed and another client's in-flight request completes normally

#### Scenario: A later service is one registry entry

- **WHEN** a service registered under namespace `watch` exposes method `subscribe`
- **THEN** `watch.subscribe` is routed to it with no change to framing, discovery or lifecycle

---

### Requirement: The daemon exits after its last client has been gone for the idle timeout

The daemon SHALL track live connections. When the last connection closes it SHALL start an idle timer of `--idle-timeout` minutes; a new connection SHALL cancel it; when it fires the daemon SHALL stop. With `--idle-timeout 0` it SHALL never stop on idle. A quiet but open connection SHALL NOT count as idle.

#### Scenario: Idle exit

- **WHEN** the only client disconnects from a daemon started with `--idle-timeout 1` and no client connects for a minute
- **THEN** the daemon stops and its socket, info file and lock are removed

#### Scenario: A quiet session keeps it alive

- **WHEN** a client stays connected for longer than the idle timeout without sending a request
- **THEN** the daemon keeps running

#### Scenario: A new client cancels the timer

- **WHEN** a client connects while the idle timer is running
- **THEN** the timer is cancelled and the daemon serves the client

---

### Requirement: Stopping is orderly and bounded

On `SIGINT`, `SIGTERM`, idle expiry or `daemon.shutdown` the daemon SHALL stop accepting connections, answer every in-flight request with a `SHUTTING_DOWN` error, end every connection, remove `daemon.json`, the socket file and `daemon.lock`, and exit `0`. If that does not complete within 5 seconds the process SHALL exit regardless.

#### Scenario: SIGTERM with clients connected

- **WHEN** a daemon with two connected clients receives `SIGTERM`
- **THEN** both connections end, the three files are removed, and the process exits `0` within 5 seconds

#### Scenario: daemon.shutdown

- **WHEN** a client calls `daemon.shutdown`
- **THEN** it receives a success result and the daemon then stops as on `SIGTERM`

---

### Requirement: The daemon records itself in an info file and a log

After listening, the daemon SHALL atomically write `daemon.json` with `pid`, `version`, `socket` path and `started_at`, and SHALL write its diagnostics to stderr, which a spawning client redirects to `daemon.log`. The info file SHALL contain no vault paths and no secrets. Nothing SHALL be written to stdout.

#### Scenario: Info file after start

- **WHEN** `daemon` has started
- **THEN** `daemon.json` exists, parses, and names the running pid and the socket path the daemon listens on

#### Scenario: Diagnostics stay off stdout

- **WHEN** the daemon logs its start, a model load, or a client error
- **THEN** the text goes to stderr and nothing is written to stdout

---

### Requirement: daemon status and daemon stop are the operator surface

`daemon status` SHALL read every `daemons/*/daemon.json`, probe each socket, call `daemon.info` on those that answer, print one line per daemon with version, pid, client count, loaded profiles and `alive`, and SHALL remove the state directory of every entry whose socket does not answer, printing it as `stale`. `daemon stop` SHALL call `daemon.shutdown` on every alive daemon, falling back to `SIGTERM` when the call does not complete, and SHALL exit `0`. Both SHALL exit `0` when no daemon is known.

#### Scenario: Status lists live and stale daemons

- **WHEN** one daemon is alive and another's info file points at a dead socket
- **THEN** `status` prints the live one as `alive` with its version, pid, clients and loaded profiles, prints the other as `stale`, and removes the stale entry

#### Scenario: Stop ends every daemon

- **WHEN** `daemon stop` runs with two live daemons of different versions
- **THEN** both stop and a following `status` reports none
