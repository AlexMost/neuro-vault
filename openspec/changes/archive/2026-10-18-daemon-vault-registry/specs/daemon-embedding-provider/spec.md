## MODIFIED Requirements

### Requirement: Any failure to reach the daemon falls back once to the in-process provider

A process SHALL hold one connection to the shared daemon and one one-way switch, shared by every daemon-backed facade it uses (embedding and corpus reads). When a facade cannot locate or start the daemon — the spawn throws, the poll times out, the CLI runs from a TypeScript source file, the CLI script changed since the session started (an upgrade or rebuild, whose daemon would listen on another key), or the platform refuses the socket — the switch SHALL flip, once per process, so the embedding provider for the same profile and the vault entries both run in-process from then on; the process SHALL write exactly one stderr line naming the reason and, when the session's build is known, the daemon log, and SHALL never touch the daemon again. A daemon that answers but reports `EMBED_FAILED` SHALL NOT cause a fallback: the error is surfaced to the caller and the next call retries through the daemon. A closed connection or a timed-out request SHALL NOT cause a fallback either. `--no-shared` SHALL select the in-process provider and in-process vault entries up front without any stderr line. The `index` command SHALL use the same factory and flag.

#### Scenario: Spawn fails

- **WHEN** spawning the daemon throws
- **THEN** the session embeds in-process from then on and stderr carries one line naming `daemon.log`

#### Scenario: Development run from source

- **WHEN** the CLI is started from `src/cli.ts` through a TypeScript runner
- **THEN** the session embeds in-process and stderr carries one line explaining why

#### Scenario: Upgraded under an open session

- **WHEN** the installed CLI script is replaced by an upgrade or rebuild while a session is open, and that session's daemon then goes away
- **THEN** the session does not spawn a daemon from the new script; it embeds and serves its vaults in-process from then on and stderr carries one line saying the CLI script changed

#### Scenario: One switch for every facade

- **WHEN** the session's startup `vault.attach` finds the daemon cannot be started
- **THEN** the embedding provider and the vault entries both run in-process, and stderr carries one fallback line, not two

#### Scenario: Model load failure is not a fallback

- **WHEN** the daemon answers `embed.initialize` with `EMBED_FAILED`
- **THEN** the session reports the failure as it would a local load failure, stays on the daemon, and retries on the next call

#### Scenario: Opting out

- **WHEN** the server or `index` is started with `--no-shared`
- **THEN** the model is loaded in-process, no daemon is probed or spawned, and stderr carries no fallback line

#### Scenario: index shares a running server's model

- **WHEN** `neuro-vault-mcp index --vault <path>` runs while a server session of the same version has the profile loaded in the daemon
- **THEN** the index run embeds through that daemon and loads no model of its own
