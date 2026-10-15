# daemon-embedding-provider Specification

## Purpose
How sessions share one embedding model: the daemon's `embed` service (one provider per profile, loaded on demand, one cross-session queue) and the session-side `DaemonEmbeddingProvider` facade, which keeps the `EmbeddingProvider` contract, finds or spawns the daemon, bounds every wait, and falls back once per process to the in-process model; `--no-shared` opts out. Rationale: ADR-0018; mechanism: `docs/architecture/shared-daemon.md#the-session-side-facade`.
## Requirements
### Requirement: The embed service loads one provider per profile on demand and queues across clients

The daemon's `embed` service SHALL accept `embed.initialize { profile }`, `embed.query { profile, text }` and `embed.documents { profile, texts }` where `profile` is a key of the closed profile registry; any other key SHALL receive a JSON-RPC error with `data.code` `UNKNOWN_PROFILE`. On the first `embed.initialize` for a profile the service SHALL build that profile's provider through the same provider factory the sessions use, in non-shared mode, and SHALL await its initialization before answering `{ identity, max_batch_size }`; later calls for the same profile SHALL reuse it, so one model per profile is loaded per daemon. Every request for a profile SHALL pass through that profile's queue, with query embeddings served ahead of queued document batches regardless of which client sent them. A provider failure SHALL be answered with `data.code` `EMBED_FAILED` and the provider's message, and SHALL NOT be cached: the next request retries. `embed.documents` SHALL reject more than `max_batch_size` texts and any blank text with `INVALID_PARAMS`.

#### Scenario: One model per profile across clients

- **WHEN** two clients each call `embed.initialize` for `harrier-270m` and then embed
- **THEN** exactly one provider for `harrier-270m` is built and both clients' vectors come from it

#### Scenario: Two profiles, two providers

- **WHEN** one client initializes `harrier-270m` and another initializes `granite-97m`
- **THEN** the service holds two providers, and `daemon.info` lists both under `services.embed.loaded`

#### Scenario: A query from one client jumps ahead of another client's indexing

- **WHEN** client A has several `embed.documents` batches queued for a profile and client B sends `embed.query` for the same profile
- **THEN** B's query is embedded before A's queued batches

#### Scenario: Load failure is reported, not cached

- **WHEN** the model for a profile cannot be loaded
- **THEN** `embed.initialize` answers `EMBED_FAILED` with the reason, and a later `embed.initialize` tries again

#### Scenario: Unknown profile

- **WHEN** a client sends `embed.initialize { profile: "bge-m3" }`
- **THEN** it receives `UNKNOWN_PROFILE`

---

### Requirement: The daemon-backed provider implements the embedding-provider contract unchanged

The session SHALL obtain its embedding provider from one factory that returns either the daemon-backed facade or the in-process provider for the selected profile. The facade SHALL implement the same contract as the in-process provider: `identity` derived from the profile, `maxBatchSize`, `initialize()`, `embedQuery(text)` and `embedDocuments(texts)`, all asynchronous. Its `identity` SHALL equal the in-process provider's identity for the same profile, so a corpus built through either is served by the other. Its `maxBatchSize` SHALL be the value the daemon reports on `embed.initialize` once known. The server's warmup SHALL await the facade's `initialize()`, and the server SHALL keep its per-process queue around the facade.

#### Scenario: Same identity either way

- **WHEN** a corpus manifest is written by a process using the facade and read by a process using the in-process provider for the same profile and version
- **THEN** the manifest is compatible and no rebuild is triggered

#### Scenario: Warmup loads the model in the daemon once

- **WHEN** a cold server starts with the facade and a second server starts a minute later
- **THEN** the model loads once, in the daemon, and the second server's warmup returns without a second load

#### Scenario: Batch size follows the daemon

- **WHEN** `embed.initialize` answers `max_batch_size: 8`
- **THEN** the facade's `maxBatchSize` is `8` and the per-process queue buckets by it

---

### Requirement: The facade finds or starts the daemon, waits for it, and bounds every wait

On first use the facade SHALL probe the version-keyed socket; when nothing listens it SHALL spawn `neuro-vault-mcp daemon` detached, with the daemon's stdout and stderr appended to `daemon.log`, using the running Node binary and the installed CLI script by absolute path, and SHALL poll the socket until it answers or 10 seconds pass. Each request SHALL carry an id and SHALL time out — 60 seconds for a query, 5 minutes for a document batch — with an error naming the method. When the connection closes, every pending request SHALL reject with a connection error and the next call SHALL probe and, if needed, spawn again.

#### Scenario: Daemon already running

- **WHEN** a daemon for this version is listening and a session starts
- **THEN** the session connects without spawning anything

#### Scenario: Daemon started on demand

- **WHEN** no daemon is listening and a session's first embedding call runs
- **THEN** a detached `daemon` process is spawned, its output goes to `daemon.log`, and the call completes once the daemon answers

#### Scenario: Two sessions start at once

- **WHEN** two sessions probe, find nothing, and both spawn a daemon
- **THEN** one daemon serves both sessions and the other exits into its log

#### Scenario: Daemon idled out mid-session

- **WHEN** the daemon exited on idle while a session stayed open and the session then embeds a query
- **THEN** the session respawns the daemon and the query succeeds

#### Scenario: A hung daemon cannot hang the session

- **WHEN** the daemon accepts a query request but never answers
- **THEN** the request rejects after the timeout with an error naming `embed.query`

---

### Requirement: Any failure to reach the daemon falls back once to the in-process provider

When the facade cannot locate or start the daemon — the spawn throws, the poll times out, the CLI runs from a TypeScript source file, the CLI script changed since the session started (an upgrade or rebuild, whose daemon would listen on another key), or the platform refuses the socket — it SHALL switch, once per process, to the in-process provider for the same profile, write exactly one stderr line naming the reason and, when the session's build is known, the daemon log, and never touch the daemon again in that process. A daemon that answers but reports `EMBED_FAILED` SHALL NOT cause a fallback: the error is surfaced to the caller and the next call retries through the daemon. `--no-shared` SHALL select the in-process provider up front without any stderr line. The `index` command SHALL use the same factory and flag.

#### Scenario: Spawn fails

- **WHEN** spawning the daemon throws
- **THEN** the session embeds in-process from then on and stderr carries one line naming `daemon.log`

#### Scenario: Development run from source

- **WHEN** the CLI is started from `src/cli.ts` through a TypeScript runner
- **THEN** the session embeds in-process and stderr carries one line explaining why

#### Scenario: Upgraded under an open session

- **WHEN** the installed CLI script is replaced by an upgrade or rebuild while a session is open, and that session's daemon then goes away
- **THEN** the session does not spawn a daemon from the new script; it embeds in-process from then on and stderr carries one line saying the CLI script changed

#### Scenario: Model load failure is not a fallback

- **WHEN** the daemon answers `embed.initialize` with `EMBED_FAILED`
- **THEN** the session reports the failure as it would a local load failure, stays on the daemon, and retries on the next call

#### Scenario: Opting out

- **WHEN** the server or `index` is started with `--no-shared`
- **THEN** the model is loaded in-process, no daemon is probed or spawned, and stderr carries no fallback line

#### Scenario: index shares a running server's model

- **WHEN** `neuro-vault-mcp index --vault <path>` runs while a server session of the same version has the profile loaded in the daemon
- **THEN** the index run embeds through that daemon and loads no model of its own

