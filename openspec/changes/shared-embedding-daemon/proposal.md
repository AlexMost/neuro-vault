Tracked by: #145

## Why

Every MCP client session spawns its own stdio `neuro-vault-mcp` and keeps it for the session's life; each one that serves a query loads its own copy of the embedding model — 450–600 MB RSS per session on harrier-270m, measured 2026-10-14 with 9 live sessions. The model is the one thing every session duplicates for no benefit. ADR-0017 already made the embedding path provider-agnostic for a remote hub; a local shared process behind that same seam removes the duplication without touching the MCP contract or any client config.

## What Changes

**A shared-services daemon: `neuro-vault-mcp daemon`**

- From: no shared process.
- To: `daemon [--idle-timeout <min>]` listens on a unix socket (a named pipe on Windows) keyed by the installed package version, speaks JSON-RPC 2.0 with the stdio framing the MCP SDK already ships, and hosts namespaced services — today `embed` (model weights plus a cross-session queue, one model per profile loaded on first request) and `daemon` (`info`, `shutdown`). It takes a lock file, cleans a stale socket, writes `daemon.json` and a log under the neuro-vault cache directory, exits after a quiet period following its last client, and tears down on `SIGINT`/`SIGTERM`. `daemon status` lists known daemons and sweeps stale ones; `daemon stop` ends them.
- Reason: the pattern every daemon-spawning CLI uses (Nx, Watchman, pm2); a socket needs no ports, no Origin guard, no session ids; the file mode is the access control; namespaced methods let lexical search and the watcher attach later without a new protocol.
- Impact: new command; no tool contract change (PR 1).

**The embedding provider becomes a facade onto the daemon**

- From: `EmbeddingService` loads the model in every server and `index` process.
- To: `DaemonEmbeddingProvider implements EmbeddingProvider` — the same `identity`, `maxBatchSize`, `initialize`, `embedQuery`, `embedDocuments` — finds or starts the daemon for this version, asks it to load the profile, and sends each request over the socket. The session keeps its own queue; the daemon's per-profile queue orders queries ahead of indexing across sessions. A dropped connection rejects in-flight requests and reconnects (and respawns) on the next call. If the daemon cannot be located or started, or the CLI runs from source, the provider falls back once per process to the in-process model with one stderr line. `--no-shared` picks the in-process model up front. `index` uses the same factory, so warming an index shares a running server's model. The interface stays what a remote embedding API would implement; the daemon builds providers through the same factory, so a remote profile can later live there.
- Reason: one model per machine; the seam already exists; the worst case is today's behaviour.
- Impact: default behaviour now starts one background process per installed version that outlives the session and exits when idle, with a log and info file under the cache directory. No contract change → minor release with explicit release notes (PR 2).

**Delivery:** two PRs — (1) daemon lifecycle, protocol, `embed` service, `daemon` command, ADR-0018, architecture doc, `Refs #145`; (2) the provider facade as default, `--no-shared`, docs, measurements, `Closes #145`. Lexical search and the watcher are later services behind the same protocol; Streamable HTTP belongs to #127.

## Capabilities

### New Capabilities

- `shared-services-daemon`: the `daemon` process — version-keyed socket path, lock and stale-socket cleanup, info file and log, JSON-RPC 2.0 over stdio framing with namespaced methods and a service registry, per-connection request handling, idle exit after the last client, signal-driven teardown, `daemon status` and `daemon stop`.
- `daemon-embedding-provider`: the `embed` service (profiles loaded on demand, one model per profile per daemon, cross-session queue with query priority) and the session-side `DaemonEmbeddingProvider` (identity, batch size from the daemon, lazy connection, spawn-and-poll, request timeouts, reconnect, once-per-process fallback, `--no-shared`), shared by the server and `index`.

### Modified Capabilities

- `cli-startup-flags`: adds the `daemon [status|stop]` command with `--idle-timeout`, and `--shared`/`--no-shared` on the server invocation and `index`.
- `semantic-backend-lifecycle`: "One embedding model serves the whole process, queries first" becomes one model per machine per profile, with the per-process queue kept and the cross-session queue in the daemon.
- `embedding-model-profiles`: "One profile serves the whole process" still selects one profile per process; its weights may be loaded by the shared daemon on the process's behalf.

## Impact

- **Dependencies**: none added. `node:net`, `node:child_process` (`spawn` with an argument array, ADR-0004), `node:crypto`; the SDK's `ReadBuffer`/`serializeMessage`/`deserializeMessage`.
- **Code**: new `src/daemon/` (paths, lock, info, probe, protocol, service registry, `embed` service, socket server), `src/cli-daemon.ts`, `src/modules/semantic/daemon-connection.ts`, `daemon-embedding-provider.ts`, `provider-factory.ts`; edited `src/server.ts`, `src/cli-index.ts`, `src/config.ts`, `src/cli.ts`, `src/types.ts`.
- **Docs**: ADR-0018 (new) + `docs/adr/INDEX.md`; `docs/architecture/shared-daemon.md` (new) + architecture `README.md`, `embedding-pipeline.md`, `semantic-backend.md`, `cli-startup.md`; `docs/guide/installation.md`, `configuration.md`; repo `README.md` ("no external processes" reworded).
- **Users**: nothing to change. One background process per installed version appears on first semantic use and leaves after 30 idle minutes; `daemon status|stop` to inspect or end it; `--no-shared` to opt out.
- **Not in scope**: sharing the lexical cache or the watcher (next services), a remote embedding provider (the seam stays open), Streamable HTTP and `/health` (#127), authentication, a service-manager install, Windows verification beyond "falls back cleanly".
