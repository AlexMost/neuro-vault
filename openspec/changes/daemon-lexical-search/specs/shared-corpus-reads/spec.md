## MODIFIED Requirements

### Requirement: Sessions attach every vault in the background at startup

At startup a session with the semantic module on SHALL attach every registered vault in the background, without delaying the MCP handshake — a semantically enabled vault with its profile, a vault that set `"semantic": false` with `profiles: []` — through one attachment per vault that its semantic backend and its lexical reader share; a `--no-semantic` session SHALL attach nothing. The vault's status SHALL read `{ state: "indexing", indexed: 0, total: 0 }` until the attach answers, including while the daemon is still being located or started, without waiting for either. A session SHALL re-send `vault.attach` for each vault once per connection to the daemon before its first call on that connection, whichever facade makes that call.

#### Scenario: A call during a cold start does not wait

- **WHEN** no daemon is running, the session has just started one, and `search_notes` arrives before the daemon listens
- **THEN** the call reads the vault's status as `indexing` 0/0 at once, and the vault attaches once the daemon answers

#### Scenario: A reconnect re-attaches

- **WHEN** the daemon idled out while a session stayed open and the session then runs `search_notes`
- **THEN** the session reconnects, attaches the vault again before any corpus read or lexical search, and the search succeeds once the entry is ready

#### Scenario: An opted-out vault attaches for its lexical leg

- **WHEN** a session starts with a vault whose config sets `"semantic": false`
- **THEN** it attaches that vault with `profiles: []` in the background, and its semantic backend still reads `disabled` without any attach of its own

#### Scenario: One attach serves both facades

- **WHEN** a hybrid `search_notes` is the first call on a new connection
- **THEN** exactly one `vault.attach` is sent for that vault before the first `corpus.*` and the first `lexical.search` call
