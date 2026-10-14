# Tasks — shared-embedding-daemon (#145)

Two PRs, in order. Groups are marked **sequential** or **parallel-safe**. Every PR ends with `npm test && npm run lint && npm run typecheck && npm run build` green and a PR via `gh pr create`.

## 1. PR 1 — the shared-services daemon (`Refs #145`)

### 1a. Lifecycle building blocks — parallel-safe (independent files, pure or DI-tested)

- [ ] 1.1 `src/daemon/paths.ts`: `daemonKey(version, build)` (12-hex sha256 of `v1:<version>:<cliSize>:<cliMtimeMs>`), `daemonPaths({ version, build, uid, platform, cacheBase })` → `{ socketPath, stateDir, infoFile, logFile, lockFile }`, `daemonCacheBase(env, home)` (the model-cache rule); tests: deterministic key, POSIX socket path < 100 bytes, Windows pipe form, XDG rule
- [ ] 1.2 `src/daemon/lock.ts`: `acquireLock(lockFile, { pid, isAlive, fs })` → `{ kind: 'acquired' } | { kind: 'held'; pid }`; `releaseLock`; tests: fresh, dead holder replaced, live holder refused, `wx` race (second create fails)
- [ ] 1.3 `src/daemon/info.ts`: `DaemonInfo` type, `writeDaemonInfo` (atomic), `readDaemonInfo` (validates shape, returns `undefined` on any fault); tests
- [ ] 1.4 `src/daemon/probe.ts`: `probeSocket(path, { connect, timeoutMs })` → `'listening' | 'refused' | 'absent'`; `cleanStaleSocket(path, deps)` (unlink only on refused/absent); tests with an injected `connect`
- [ ] 1.5 `src/daemon/protocol.ts`: method/params/result types for `daemon.*` and `embed.*`, error `data.code` union, `ServiceRegistry` (`register(namespace, handlers)`, `dispatch(request) → response`), JSON-RPC error helpers; tests: routing, `UNKNOWN_METHOD`, `INVALID_PARAMS`, handler rejection → `EMBED_FAILED`-class error with the message

### 1b. Services and server — sequential (1.6 and 1.7 after 1a; 1.8 after both)

- [ ] 1.6 `src/daemon/services/embed.ts`: `createEmbedService({ createProvider })` with `Map<profileKey, { provider, queue }>`; `embed.initialize` resolves the profile, builds via the factory on first use, awaits `initialize()`, answers `{ identity, max_batch_size }`; `embed.query`/`embed.documents` go through that profile's `QueuedEmbedder`; `UNKNOWN_PROFILE` for a key outside the registry; `loaded()` for `daemon.info`; tests with a fake provider: one build per profile across many calls, two profiles → two providers, query ahead of a queued document batch, blank text rejected as `INVALID_PARAMS`
- [ ] 1.7 `src/daemon/services/daemon.ts`: `daemon.info` (name, version, pid, started_at, idle_timeout_min, clients, services), `daemon.shutdown`; tests
- [ ] 1.8 `src/daemon/socket-server.ts`: `startDaemonServer({ socketPath, registry, idleTimeoutMs, onIdle, timers })` — `net.createServer`, per-connection `ReadBuffer` + `serializeMessage`, a bad line closes only that connection, live-connection set, idle timer armed/disarmed, `close()` ends connections and answers in-flight with `SHUTTING_DOWN`; tests over a real unix socket under a short tmp path: `daemon.info` round trip, two concurrent clients, bad line isolation, idle timer with fake timers, close rejects in-flight

### 1c. Command — sequential after 1b

- [ ] 1.9 `test/config.test.ts` (failing) then `src/config.ts`: `daemon [action]` command (positional `action` with choices `status`, `stop`, optional), `--idle-timeout` (integer ≥ 0, default 30, declared once), no `--vault`/`--model` on `daemon`; `ParsedCli` gains `{ kind: 'daemon'; options: DaemonCliOptions }`; `src/cli.ts` branch
- [ ] 1.10 `src/cli-daemon.ts`: `runDaemonCommand(options, deps)` — run: lock → clean → `startDaemonServer` → chmod → info file → stderr line → signals (`SIGINT`/`SIGTERM` once each) → stop path with 5 s deadline, exit codes per spec; `status`: scan `daemons/*`, probe, `daemon.info`, print, sweep stale; `stop`: `daemon.shutdown` each, `SIGTERM` fallback; tests with injected fs/connect/spawn/timers/exit for every branch (lock held by live pid, stale leftovers cleaned, race loser, idle exit, `status` live+stale, `stop` with an unresponsive daemon)
- [ ] 1.11 Manual check (recorded in verify): `npm run build`; `node dist/cli.js daemon --idle-timeout 1`; raw `nc -U` session: `daemon.info`, `embed.initialize {profile:"granite-97m"}`, `embed.query`, `embed.documents` ×8; second `daemon` exits 1; kill -9 then restart cleans leftovers; `SIGTERM` exits < 5 s; idles out after a minute; `daemon status` / `daemon stop`

### 1d. Docs — parallel-safe after 1.10

- [ ] 1.12 ADR-0018 `docs/adr/0018-shared-services-daemon.md` (after user ack) + `docs/adr/INDEX.md` row
- [ ] 1.13 `docs/architecture/shared-daemon.md` (new: lifecycle, paths, protocol table, service registry, how a service attaches, how a remote provider would live in the daemon) + `docs/architecture/README.md` entry; pointer in `cli-startup.md` (`daemon` outcome)

## 2. PR 2 — the embedding facade as default (`Closes #145`)

### 2a. Connection and facade — sequential

- [ ] 2.1 `src/modules/semantic/daemon-connection.ts`: `DaemonConnection({ paths, connect, spawn, cliPath, pollIntervalMs, pollTimeoutMs, timers, stderr })` — `ensure()` (probe → spawn detached with stdio to `daemon.log` → poll), `request(method, params, timeoutMs)` with ids and a pending map, socket close rejects pending with `DaemonConnectionError`, `.ts` cliPath → `DaemonUnavailableError`; tests with injected `connect`/`spawn` (already listening; spawn then poll succeeds; spawn throws; poll times out; mid-request close; timeout)
- [ ] 2.2 `src/modules/semantic/daemon-embedding-provider.ts`: `DaemonEmbeddingProvider({ profile, connection, fallback, stderr })` implementing `EmbeddingProvider`: `identity = identityOf(profile)`, `maxBatchSize` updated from `embed.initialize`, `initialize`/`embedQuery`/`embedDocuments` over `request`, `EMBED_FAILED` → thrown error (retry next call, no fallback), `DaemonUnavailableError` → switch once to the fallback provider with one stderr line; tests for every path, including "fallback happens once and later calls never touch the connection"
- [ ] 2.3 `src/modules/semantic/provider-factory.ts`: `createEmbeddingProvider({ profile, shared, cliPath, env, home })`; tests: `shared: false` → `EmbeddingService`; `shared: true` → facade wired with real paths

### 2b. Wiring — sequential after 2a

- [ ] 2.4 `test/config.test.ts` (failing) then `src/config.ts`: `--shared` (boolean, default `true`, declared once) on the server command and `index`; `ServerConfig.semantic.shared`, `IndexCliOptions.shared`
- [ ] 2.5 `src/server.ts` and `src/cli-index.ts` build their provider through `createEmbeddingProvider` (cliPath = realpath of the running `cli.js`, resolved in `cli.ts`); `test/server-modules.test.ts` and `test/cli-index.test.ts` keep passing with `shared: false` in their fixtures; a new test asserts the server's warmup awaits the facade's `initialize`
- [ ] 2.6 `src/daemon/services/embed.ts` builds providers via `createEmbeddingProvider({ shared: false })` (closes the loop with D7)
- [ ] 2.7 Manual check (recorded in verify): two Claude Code sessions → `daemon status` shows `clients: 2`, one loaded profile; `search_notes` in both; `neuro-vault-mcp index` while a server runs → no second model; rebuild → new session gets a second daemon, old sessions keep working, old daemon idles out; `--no-shared` in-process; `npm run dev -- --vault <v>` falls back with one stderr line
- [ ] 2.8 Measure for verify: RSS of one daemon + 3 sessions vs 3 stdio processes after 5 `search_notes` each; p95 of `search_notes` with 3 concurrent sessions (throwaway script in the session scratchpad)

### 2c. Docs and close-out — sequential after 2b

- [ ] 2.9 `docs/architecture/embedding-pipeline.md` (provider factory, the facade, where the model lives), `semantic-backend.md` (queue in two places), `shared-daemon.md` (facade section); `docs/guide/installation.md` (what runs, where `daemon.log` is, idle exit), `configuration.md` (`--shared`/`--no-shared`, `daemon status|stop`, `--idle-timeout`; limitations list reworded); repo `README.md` ("no external processes" → one shared background process per installed version, on demand, gone when idle)
- [ ] 2.10 `/opsx:verify` → `verify.md` with 1.11, 2.7 and 2.8; `retrospective.md`; `/opsx:archive` (specs synced); final PR carries `Closes #145` and release notes for the minor
