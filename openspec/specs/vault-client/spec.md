# vault-client Specification

## Purpose
How a session reaches a vault entry: one vault client per vault root and side (the daemon connection or the in-process loopback over the daemon's own service handlers), the per-vault method table both sides type against, one error vocabulary, no connection id in the session, and views (the semantic backend, the lexical reader) as the only readers. Rationale: ADR-0021; mechanism: `docs/architecture/semantic-backend.md` and `docs/architecture/shared-daemon.md`.
## Requirements
### Requirement: A session reaches each vault entry through one vault client per vault root and side
A session SHALL reach a vault entry only through that vault root's vault client: one over the process's daemon connection and one over the process's in-process vault entries, each built on first use. The client SHALL expose `call(method, params)` typed by the method table, `status(profile)`, `warm()` and `dispose()`. Every per-vault reader of the session — the semantic backend, the lexical reader, and any later one — SHALL be a view over its vault's client and SHALL NOT hold a connection, a fallback switch, an attach or a `local` fallback of its own. The client over the daemon connection SHALL consult the process's one-way switch on every call and, once it answers `local`, SHALL serve every call from the vault's in-process client.

#### Scenario: One attach per vault per connection epoch
- **WHEN** a vault with a semantic backend and a lexical reader serves a hybrid `search_notes` on a new daemon connection
- **THEN** the session sends exactly one `vault.attach` for that vault on that connection before its first `corpus.*` or `lexical.search` call, and both legs use the key it answered

#### Scenario: The switch moves every reader of a vault at once
- **WHEN** the daemon cannot be located or started on the first call of a session
- **THEN** that vault's semantic reads and lexical searches are both served by the in-process vault entry, and the stderr line is written once

#### Scenario: Status while attaching
- **WHEN** a semantic tool reads a vault's status while the switch is still undecided or its attach is in flight
- **THEN** the status reads `indexing` with 0 of 0 notes at once, and the attach proceeds in the background

---

### Requirement: The method table is typed once and shared by both sides of the socket
The per-vault read methods SHALL be declared once, as rows of `VaultMethods` in `src/daemon/protocol.ts` (`corpus.nearest`, `corpus.nearestBlocks`, `lexical.search`), each row naming its wire params and result. The daemon's services and the session's views SHALL type against these rows, and a client SHALL add the vault key it attached under to every call, so a view never sends one. `vault.attach` and `vault.status` SHALL be the client's own lifecycle, not rows a view calls.

#### Scenario: A view cannot send a vault key
- **WHEN** a view calls `client.call('corpus.nearest', params)`
- **THEN** `params` has no `vault` field by type, and the request carries the realpath key of the current attach

---

### Requirement: Both sides answer a read with one error vocabulary
The in-process vault client SHALL dispatch every call to the same service handlers the daemon registers (`vault`, `corpus`, `lexical`), built once by one function, and SHALL answer a refusal as the protocol's error with the code and message the daemon would send. A view SHALL map that vocabulary to its interface's domain error the same way whichever side served the call. Only the client over the daemon connection SHALL add transport failures (a timeout, a dropped connection, closed services). A `NOT_ATTACHED` answer SHALL make the client forget the attach, so the next call attaches again; no view SHALL handle it.

#### Scenario: A corpus that is not ready refuses the same way on both sides
- **WHEN** a semantic read reaches a profile that is `indexing`, once through the daemon and once through the in-process client
- **THEN** both reject with the readiness error carrying the profile's status

#### Scenario: A detached vault re-attaches on the next call
- **WHEN** a read is answered `NOT_ATTACHED`
- **THEN** that read fails, and the next read of the vault sends `vault.attach` first

---

### Requirement: The in-process client needs no connection id
The in-process side SHALL send every vault's calls through one in-process link per process, whose client id is private to the link, and closing that link SHALL detach it from every entry it attached, as a closed connection does in the daemon. No session-side module outside the link SHALL name a connection id.

#### Scenario: Disposing the fallback detaches it
- **WHEN** a session served in-process shuts down
- **THEN** its in-process link is closed, which detaches it from every vault entry, and then the entries are disposed

---

### Requirement: A new per-vault read is a table row, a handler and a view
Adding a per-vault read method SHALL require only a row in the method table, its service handler registered in the shared service map, and a view; neither client adapter, the link, the attachment nor the factory that builds the clients SHALL change.

#### Scenario: A hypothetical read through both adapters
- **WHEN** a test adds a row to the method table, registers its handler on the daemon side and in the in-process service map, and calls it through a view on both adapters
- **THEN** both calls answer, with no change to any adapter, and the project's typecheck passes over that test

