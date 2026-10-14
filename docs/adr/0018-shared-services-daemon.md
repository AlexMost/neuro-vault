# ADR-0018 — A shared-services daemon per installed build; the embedding provider is its first client

- **Status**: Accepted
- **Date**: 2026-10-14

## Context

Every MCP client session runs its own stdio `neuro-vault-mcp` for as long as the session lasts, and each one that serves a query loads its own copy of the embedding model. Measured on 2026-10-14 with `harrier-270m` and nine live sessions (#145): 450–600 MB RSS per session that had embedded a query, 55–85 MB idle. The model is the difference, and it is the one thing every session duplicates for no benefit. The same snapshot showed two smaller costs of N independent processes: N watchers and reconcile loops over one corpus, and, after `npm run build`, six of nine processes still running the previous build's code. In one observed case, two pre-v17 sessions and five v17 sessions rebuilt a 953-shard corpus against each other on every trigger, and one process accumulated 78 CPU-minutes. Writes are atomic, so nothing corrupted; the cost was memory, duplicated work and stale code.

[ADR-0017](0017-embedding-model-profiles.md) had already made the embedding path provider-agnostic: `EmbeddingProvider` is asynchronous, self-describing (`identity`), and has queries and documents as separate calls. A provider that forwards to another process fits behind it without changing anything else in the session.

Research on how CLIs that spawn a shared daemon talk to it:

| Tool | Channel | Discovery | Version mismatch | Idle |
| --- | --- | --- | --- | --- |
| Nx | unix socket (`/tmp/.nx/<uid>/sockets`), named pipe on Windows | `connect` probe on the socket; pid and version in a cache JSON beside it | treated as "no daemon"; a new one is started | 3 h |
| Watchman | unix socket, one JSON PDU per line | `get-sockname`; the CLI spawns the service | — | one per user |
| pm2 | two unix sockets under `~/.pm2` | `connect` probe on `rpc.sock`; `spawn` detached, stdio to a log file | — | never |
| Turborepo | unix socket + pid file in tmp | reads the pid file, connects | — | stale pid files are the top complaint |
| Gradle | localhost TCP + a file-locked registry | registry entry; incompatible → new daemon | one daemon per Gradle version | 3 h |
| Bazel | one server per workspace | by output base | the client stops the old server and starts a new one | 3 h |

They converge on a unix socket or named pipe, a detached spawn with stdio to a log, readiness by polling `connect`, identity in an info file beside the socket, and a lock file. The recurring failure is a stale socket or pid file, and the fix the sources agree on is a `connect` probe under a lock (`ECONNREFUSED` → unlink), never file size or age. macOS caps a unix socket path at 103 bytes, and its `$TMPDIR` alone is 48. The MCP spec says a custom transport over a byte stream SHOULD reuse the stdio framing, and the SDK exports it (`ReadBuffer`, `serializeMessage`, `deserializeMessage`).

Two earlier designs were weighed and withdrawn on the same day:

1. **A stateless Streamable HTTP daemon on 127.0.0.1, plus `service install`** (a launchd LaunchAgent or a `systemd --user` unit, and a client config to paste). It needed an Origin/Host guard, a fixed port with `--port` and an `EADDRINUSE` diagnosis, a unit that pins absolute Node and script paths (and breaks on every nvm upgrade), and a change to every client's config. Claude Code's HTTP client also has a recurring, re-opened bug where it does not re-initialize after a `404 Session not found`, which would strand open sessions on every restart. Withdrawn because once nothing MCP-level is shared, none of that buys anything; Streamable HTTP keeps its place for the hosted hub (#127).
2. **The whole MCP server in a daemon, reached by a stdio byte-pump shim** (`StdioServerTransport(socket, socket)` per connection, with `neuro-vault-mcp` itself piping stdin and stdout to the socket). It would also have removed the duplicated watchers and lexical caches, but it changes the default process model, needs the server runtime split out of `startNeuroVaultServer`, keys a daemon per vault configuration, and is a breaking release. Withdrawn in favour of sharing only the model first; it remains a possible later step over the same lifecycle.

## Decision

Run **one shared-services process per installed build per user**, reached over a local socket, and make the embedding provider its first client.

- **Channel and protocol.** A unix socket at `/tmp/neuro-vault-<uid>/<key>.sock` (directory `0700`, socket `0600`), or `\\.\pipe\neuro-vault-<uid>-<key>` on Windows. JSON-RPC 2.0, one message per line, framed and validated by the SDK's stdio `ReadBuffer`/`serializeMessage`. Methods are namespaced `<service>.<method>` and routed by a registry `namespace → { method: handler }`: `daemon.info`, `daemon.shutdown`, `embed.initialize`, `embed.query`, `embed.documents`. Errors carry `data.code` ∈ `UNKNOWN_METHOD | INVALID_PARAMS | UNKNOWN_PROFILE | EMBED_FAILED | SHUTTING_DOWN` (plus `INTERNAL` for an unexpected throw). No ports, no HTTP, no session ids: the socket file's mode is the access control.
- **Key the daemon per build; never kill.** `key = sha256("v1:" + version + ":" + cliSize + ":" + cliMtimeMs)`, first 12 hex characters, where size and mtime are those of the running CLI script. An upgrade, or a rebuild of a symlinked dev install without a version bump, gets a new daemon. New sessions attach to it; old sessions keep the old one until it idles out. No daemon is ever stopped to make room for another.
- **Share the model, nothing else.** Sessions stay full in-process MCP servers. The daemon's `embed` service holds one provider and one cross-session query-first queue per profile. It is built on the first request for that profile through the same provider factory the session uses (`createEmbeddingProvider({ shared: false })`), so profiles load on demand and the daemon starts without a model.
- **Idle from the last client.** The idle timer (`--idle-timeout`, default 30 minutes, `0` = never) runs while no client is connected: armed at listen, disarmed by a connection, re-armed when the last one closes. An open, quiet session keeps the daemon alive.
- **Stale state is cleaned under a lock.** An exclusive `daemon.lock` with the holder's pid; a dead holder is replaced, a live one wins. A socket file is unlinked only when `connect` is refused; any ambiguous probe result counts as listening. `daemon.json` records `pid`, `version`, `socket`, `started_at`, `cli_size` and `cli_mtime_ms`. Stopping (signal, idle, `daemon.shutdown`) answers in-flight requests with `SHUTTING_DOWN`, removes the files and exits 0 within a 5 s deadline. `daemon status` and `daemon stop` are the operator surface.
- **Any doubt → in-process.** The session-side facade (`DaemonEmbeddingProvider`, delivered after this ADR) falls back once per process to today's in-process model when the daemon cannot be found or started, or when the CLI runs from source; `--no-shared` selects the in-process model up front. A model that fails to load in the daemon (`EMBED_FAILED`) is an error retried on the next call, not a reason to fall back.

## Consequences

- **One model per profile per machine.** Every server session and `index` run of a build shares one loaded copy. A session's own queue keeps per-process batching and one request in flight; the daemon's queue puts any session's query ahead of every session's queued indexing batches. A second `--model` adds a second model to the same daemon, not a second daemon.
- **A background process and its files.** A process the user did not start explicitly runs per installed build and leaves after 30 idle minutes. Its socket lives under `/tmp/neuro-vault-<uid>/`, its state under the neuro-vault cache directory (`daemon.json`, `daemon.log`, `daemon.lock`). No tool contract changes, so the facade ships as a minor release whose notes say what runs, where its files are and how to opt out.
- **Upgrade overlap is bounded, not prevented.** A build that changes the embedding model leaves old sessions on the old daemon and new sessions on the new one, reconciling the same corpus against each other until the old sessions end and the old daemon idles out. With N stdio processes the overlap was every session; with daemons it is two processes, `daemon status` makes it visible, and `daemon stop` ends it early.
- **What remains duplicated.** N watchers, N reconcile loops and N lexical caches stay per session. They are the named next services (`watch.*`, `lexical.*`), each one registry entry over the same key, socket, framing and lifecycle.
- **Opt-out.** `--no-shared` in the client config restores today's behaviour exactly.
- **The seam stays open for a remote provider.** Because the daemon builds providers through the shared factory, a later remote profile (API key, rate limit, response cache) can live in the daemon with no protocol or facade change. Nothing outside `EmbeddingService` may assume the model is local.
- **Platforms.** Windows uses a named pipe, has no stale file to clean, and is not verified beyond "the facade falls back cleanly".
- **Constraint on what follows.** A new shared capability is a namespaced service plus a session-side facade over an interface the session already depends on, with in-process fallback. It does not get a new protocol, a new process or a port.

## Alternatives considered

- **Stateless Streamable HTTP on 127.0.0.1 plus a stdio shim**: an Origin guard, port collisions, `--port` and Claude Code's re-initialize bug, all for clients that never leave the machine. It belongs to the hub (#127).
- **`service install`** (launchd / `systemd --user`): a platform matrix, Node-path pitfalls on every nvm upgrade, and a client-config change; an on-demand spawn needs none of these.
- **Share the whole MCP server over the socket**: also removes the duplicated watchers and lexical caches, but changes the default process model and needs a breaking release. It is deferred as a later step, not rejected.
- **Kill older daemons on upgrade** (Bazel's approach): disconnects live sessions mid-call. Per-build keying with idle exit gets the same end state without that.
- **Key by version alone**: the owner's symlinked install would keep serving pre-rebuild code to new sessions. Build size and mtime join the key.
- **Key by profile or by vault set**: a second daemon per profile is fine for one service and wrong once per-vault services must find the one shared process of an install.
- **Idle from the last request**: kills the daemon under an open but quiet session, which would then respawn it for nothing.
