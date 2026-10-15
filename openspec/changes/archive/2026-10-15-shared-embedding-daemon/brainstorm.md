# Brainstorm — local-http-daemon (#145)

Raw decision log. Path: **architectural** (a second transport, a new process lifecycle, a new OS-service surface, a restructuring of `startNeuroVaultServer`). The problem statement and proposal skeleton are #145; this log records what the code, the SDK, the prior art and the user's answers settled on top of it. It does not re-argue the problem.

## Background

- **Today.** One stdio process per MCP client session. `startNeuroVaultServer` (`src/server.ts`) builds, in one function: the one `EmbeddingService` + queued embedder + corpus identity (design D7), the `VaultRegistry` (per-vault reader/scope/graph/provider/backend-with-watcher), one `McpServer`, the semantic module (3 tools + `warmup`) and the operations module (11 tools + resources), registers everything, connects `StdioServerTransport`, fires warmup, and chains `dispose()` onto `transport.onclose` plus stdin `end`/`close` (design D10, ADR-0014). Signals are deliberately not handled in stdio mode.
- **Measured cost of that shape** (#145, 2026-10-14, harrier-270m): 450–600 MB RSS per session that has served a query, 55–85 MB idle; N watchers and N reconcile loops over the same `<vault>/.neuro-vault/corpus/`; and after `npm run build`, 6 of 9 live processes still ran the previous version's code against a corpus the new version had rebuilt. Writes are atomic, so nothing corrupts — the cost is memory, duplicated work and stale code.
- **CLI today.** `parseConfig` (`src/config.ts`, yargs) has two commands sharing `VAULT_OPTION` and `MODEL_OPTION`: `$0` (stdio server) and `index`. `ParsedCli` is a closed union (`run | index | handled`), so `main` cannot fall through into the wrong branch (`docs/architecture/cli-startup.md`).
- **SDK in the tree: `@modelcontextprotocol/sdk` 1.29.0.** `server/streamableHttp.js` exports `StreamableHTTPServerTransport` — a `node:http` wrapper (`handleRequest(req, res, parsedBody?)`) around the web-standard transport. Session mode is chosen by `sessionIdGenerator`: a function → stateful (Mcp-Session-Id, 400 without it, 404 for an unknown one, DELETE ends it); `undefined` → stateless, and the transport throws if reused across requests ("Create a new transport per request"). Its built-in `allowedHosts`/`allowedOrigins` DNS-rebinding check is marked deprecated and compares the *whole* `Host` header (port included). `server/express.js` offers `createMcpExpressApp`, but `express` is the SDK's dependency, not ours, and ships no types we have — importing it would make us depend on a transitive. The SDK's own `examples/server/simpleStatelessStreamableHttp.js` builds a fresh `McpServer` + transport per request and closes the transport on `res.close`.
- **Prior thinking (source: private vault task note on #127, 2026-10-12).** The hub needs Streamable HTTP, several concurrent clients, one process over all shared vaults; open questions were stateless vs stateful "for Claude Code / Cursor", RSS/p95 under 5–10 clients, and watcher behaviour on a sidecar-updated checkout. The local daemon is the single-user prefix of that.

## Research (2026-10-14)

What was checked on the web, and what each finding settles. Sources are listed at the end.

1. **MCP transport spec.** Servers MUST validate `Origin` (403 on failure) and SHOULD bind only to 127.0.0.1 when local. Session IDs are optional; a client receiving 404 on a session request MUST start a new session with a fresh `initialize`. → Loopback bind is a requirement, not a choice; the Origin guard is mandatory.
2. **Claude Code HTTP client.** Config is `{"type": "http", "url": ...}` — an entry with `url` and no `type` is read as **stdio** and fails. CLI form: `claude mcp add --transport http <name> <url>`. First connection: 3 retries on connection-refused/5xx/timeout, then "failed". A dropped connection mid-session: 5 reconnects with exponential backoff from 1 s (≈ 31 s), then `disconnected · open /mcp to reconnect`; `claude -p` keeps retrying in the background for ~30 min. **A recurring, re-opened bug**: Claude Code does not re-initialize after a 404 `Session not found` (#9608 → "fixed" in 2.1.41 → #62008 still broken in 2.1.109 → #75976 regression in 2.1.205 routes the 404 into OAuth error parsing). → With stateful sessions, every `service restart` (the upgrade path this change exists for) would strand every open Claude Code session until a manual `/mcp` reconnect. Stateless has no session to lose.
3. **Cursor HTTP client.** `mcp.json` entry with `url`; Cursor probes and falls back to SSE when Streamable HTTP is not implemented; session handling undocumented. → Stateless is safe; the `/mcp` endpoint must implement POST and GET.
4. **Prior art: mcp-local-hub** (Windows-first "one shared daemon per OS user"): fixed port per server; Task Scheduler / `systemd --user` with best-effort `loginctl enable-linger`; launchd on the roadmap; loopback-only with DNS-rebind guards; it *rewrites* client config files with timestamped backups and a `rollback` command; one client (Antigravity) rejects loopback HTTP, so it ships a stdio relay. → Keep stdio untouched as the fallback for such clients. Do **not** rewrite client configs: print the snippet instead and skip the backup/rollback machinery entirely.
5. **Port policy in local daemons.** Ollama (11434), LM Studio (1234): fixed default, override by env/setting, no auto-fallback. Syncthing picks a random port if 8384 is taken *at install* — and its docs warn you then have to find it in the config. Bug reports across daemons converge on three lessons: "port in use" is not "my daemon is running" (ghost sockets pass neither check the same way); a pid/port file on disk goes stale and must be re-verified by a health probe anyway; a health response should carry the version so a launcher can tell a stale daemon from a current one. → Fixed default port with `--port`; on `EADDRINUSE` probe `/health` and say exactly what holds the port; no fallback port (clients hold a fixed URL); no pid/port file — `/health` is the only truth.
6. **Service installation from an npm global.** launchd and systemd do not run a shell, so a unit must name the absolute Node binary and the absolute script — never `neuro-vault-mcp` from `PATH`. The nvm pitfall is the documented one (pm2 `startup`: "re-run after every Node upgrade"). Per-user placement: `~/Library/LaunchAgents/<label>.plist` loaded with `launchctl bootstrap gui/<uid>` / `bootout`, `KeepAlive` + `RunAtLoad`, `StandardOutPath`/`StandardErrorPath`; `~/.config/systemd/user/<name>.service`, `WantedBy=default.target`, `systemctl --user daemon-reload && enable --now`, `loginctl enable-linger` only if the daemon must survive logout. → `service install` writes `process.execPath` + the realpath of the running `cli.js` into the unit; `service status` detects when either path no longer exists and says to re-run `install`. No postinstall, no new dependency, so `npm i -g` stays the whole install.
7. **Loopback name resolution.** `localhost` may resolve to `::1` first; the daemon binds `127.0.0.1`. → Every printed URL is `http://127.0.0.1:<port>/mcp`, never `localhost`.

## Settled before this log (from #145 and the user's answers, not revisited)

1. Stdio stays the default; `serve` is opt-in. Read-write: the full tool surface. No authentication; loopback only (anything network-reachable is #127).
2. One set of backends per process — embedder, embed queue, corpus, watcher, lexical index — shared by every client.
3. `service install|uninstall|status|restart` writes a launchd LaunchAgent on macOS and a `systemd --user` unit on Linux and prints the client config to paste.
4. `GET /health` reports version, model key and per-vault index state so a stale daemon is detectable.
5. User answers (2026-10-14): **stateless** session mode; **fail loudly** on a taken port; **one opsx change delivered as three PRs**, foundation first.

## Decision chain

### Q1. How is the work split, and what does each PR ship?

Three PRs, each independently mergeable and releasable, each one session of work:

| PR | Content | Visible change |
|---|---|---|
| 1 `Refs #145` | Extract backend assembly out of `startNeuroVaultServer` into a runtime module: build embedder, registry, module tools/resources and `dispose` **once**; build an `McpServer` from that runtime on demand. Stdio path rewired onto it, behaviour and tests unchanged. | none (refactor) |
| 2 `Refs #145` | `neuro-vault-mcp serve --vault … [--port 7531]`: `node:http` listener on `127.0.0.1`, Host/Origin guard, stateless Streamable HTTP at `/mcp` (fresh transport + `McpServer` per request over the shared runtime), `GET /health`, EADDRINUSE diagnosis, SIGINT/SIGTERM teardown. ADR-0018, `docs/architecture/http-daemon.md`, guide pages. | `serve` command |
| 3 `Closes #145` | `neuro-vault-mcp service install|uninstall|status|restart`: launchd + systemd --user generators, unit (re)load, health wait, printed client config, stale-version detection. Docs: installation guide "Run it as a service", upgrade path. Verify → retro → archive. | `service` command |

Why PR 1 is separate: it is the move #115 asks for and touches the most-changed file in the repo; landing it alone keeps the stdio behaviour diff reviewable as "pure extraction" with the existing shutdown tests as the oracle. Why PR 2 before PR 3: `serve` is useful on its own (run it in a terminal, or under any supervisor the user already has) and `service` is pure packaging on top of it.

### Q2. Where does the shared runtime live, and what is its shape?

Options: (a) keep everything in `server.ts` and add a `serve` branch inside `startNeuroVaultServer`; (b) a `src/server-runtime.ts` that owns assembly, with `server.ts` keeping only the stdio wiring and a `src/cli-serve.ts` keeping only the HTTP wiring; (c) a `src/runtime/` directory.

(a) makes the most-changed file bigger and mixes two lifecycles (hang-up vs signal) in one function. (c) is a directory for one file.

**Decision — (b).**

```ts
// src/server-runtime.ts
export interface ServerRuntime {
  readonly registry: IVaultRegistry;
  readonly modelKey: string;
  readonly tools: ToolRegistration[];
  readonly resources: ResourceRegistration[];
  /** Loads the model if any vault embeds; never rejects (reports to stderr). */
  warmup(): void;
  /** Releases every vault's watcher/backend; never rejects. Idempotent. */
  dispose(): Promise<void>;
}
export async function createServerRuntime(config: ServerConfig, deps?: ServerRuntimeDependencies): Promise<ServerRuntime>;
export function buildMcpServer(runtime: ServerRuntime, factory?: (instructions: string) => ToolServer): ToolServer;
```

`createServerRuntime` holds what `startNeuroVaultServer` holds today up to (not including) `serverFactory(...)`: the embedder, identity, registry, `buildDefaultVaultEntryDeps` (moved here — this is #115's "assembly module" option; `server.ts` stops importing module internals, the runtime module imports them instead), the semantic and operations modules, the `anyVaultEmbeds` warmup gate, and the `Promise.allSettled` disposer. `buildMcpServer` does the `registerTool`/`registerResource` loop — the tool registrations close over the registry, so registering them on a second `McpServer` is a loop over an array, not a rebuild. `startNeuroVaultServer` becomes: runtime → `buildMcpServer` → stdio transport → warmup → the existing `onclose` + stdin chain, calling `runtime.dispose()`. `NeuroVaultStartupDependencies` keeps its fields; `semantic` and `vaultEntryDeps` are forwarded to the runtime.

### Q3. Stateful or stateless sessions?

Stateful (the issue's sketch: one `McpServer` per client session, session map keyed by Mcp-Session-Id) vs stateless (no session id; a fresh transport + `McpServer` per HTTP request, as the SDK's stateless example does).

What a session would buy us: server-initiated notifications (`tools/list_changed`, logging) and per-client state. We send none and keep none: every tool is a pure function over the shared registry, the tool list is fixed at startup, resources are static. What a session costs: an in-memory map that grows for every client that exits without `DELETE` (so an idle reaper), and — the decisive point — a 404 for every open client after every daemon restart, which Claude Code has repeatedly failed to recover from (research §2). The restart is the upgrade path this change exists to make painless.

**Decision — stateless** (user ack). Per request: `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`, `buildMcpServer(runtime)`, `server.connect(transport)`, `transport.handleRequest(req, res)`, and `res.once('close', () => void transport.close())`. Building an `McpServer` per request is the SDK-sanctioned pattern and costs a loop over 14 registrations. SSE stays the response mode (`enableJsonResponse` left at its default) so clients that open the optional GET stream get the spec-conformant behaviour. Recorded as a decision with its trigger, so it can be revisited if a notification ever becomes necessary: ADR-0018 (Q12).

### Q4. Port: default, override, collision.

**Decision:** `--port <n>`, default **7531**, bind `127.0.0.1` only (no `--host`; the network case is #127). On `EADDRINUSE`: `GET http://127.0.0.1:<port>/health` with a 1 s timeout. If it answers with this server's `name`, exit 1 with `neuro-vault-mcp v<their version> (pid <n>) is already serving on port <port>; use \`service restart\` to replace it, or --port for a second daemon`. Otherwise exit 1 with `port <port> is in use by another program; pick one with --port`. Never fall back to another port: the client URL is pasted once and must stay true. No pid/port file: the port is the contract and `/health` is the liveness and identity check (research §5).

### Q5. Host/Origin guard.

Options: the transport's deprecated `allowedHosts`/`allowedOrigins` (compares the whole `Host` header, so every `host:port` combination must be listed); the SDK's `hostHeaderValidation` express middleware (pulls express into our import graph); our own check in the `node:http` handler.

**Decision — own guard**, one pure function `isLoopbackRequest(headers): string | undefined` (returns the rejection reason), applied to every route before anything else: the `Host` hostname (port stripped, IPv6 brackets kept) must be one of `127.0.0.1`, `localhost`, `[::1]`; `Origin`, when present, must parse to one of those hostnames; failure is **403** with a JSON-RPC error body and no id, as the spec allows. A missing `Origin` is accepted — MCP CLIs send none; the guard exists for browsers, which always send it.

### Q6. Process lifecycle in `serve` mode.

The stdio chain (hang-up → `transport.close()` → `dispose()`) does not apply: clients come and go per request, and nothing reads stdin. **Decision:** `serve` installs `SIGINT` and `SIGTERM` handlers (once each): stop accepting (`server.close()`), `runtime.dispose()`, then `process.exit(0)`; a 5 s deadline forces the exit if a watcher close hangs. This is the one place the repo handles signals, and it is documented as such next to the stdio comment that says why stdio does not. launchd `bootout` and systemd `stop` both send SIGTERM, so `service restart`/`uninstall` go through the same path.

Startup order: listener bound **before** warmup — the model takes seconds to load and Claude Code's first-connect budget is 3 attempts; a bound port that answers `initialize` immediately and queues the first embed behind warmup is what keeps the client connected. One stderr line on listen: `neuro-vault-mcp v17.0.0 serving 2 vaults at http://127.0.0.1:7531/mcp`.

### Q7. `/health` shape.

```json
{ "name": "neuro-vault-mcp", "version": "17.0.0", "pid": 4242, "uptime_s": 912,
  "model": "harrier-270m",
  "vaults": [ { "name": "Obsidian", "semantic": { "state": "ready" } },
              { "name": "Work", "semantic": { "state": "indexing", "indexed": 12, "total": 840 } } ] }
```

`semantic` is the backend's live `status()` verbatim (same shape as `semantic_status` on `search_notes`), `{ "state": "off" }` when the semantic module is disabled for the process. 200 always; the daemon is "healthy" if it answers. No secrets, no paths beyond vault aliases. Consumers: `serve`'s EADDRINUSE probe, `service status`/`restart`, humans with curl.

### Q8. What `service` writes and runs.

**Decision:** two pure generators (`renderLaunchdPlist(spec)`, `renderSystemdUnit(spec)`) over one `ServiceSpec { execPath, scriptPath, args, logDir }` plus a thin per-platform runner that calls `launchctl`/`systemctl` through `execFile` (ADR-0004) with an injected executor. `scriptPath` = `realpathSync(fileURLToPath(import.meta.url))` of the running CLI — the one bundled `dist/cli.js`, so after `npm i -g` the same path holds the new build and `service restart` is the whole upgrade. `execPath` = `process.execPath`.

- macOS: `~/Library/LaunchAgents/neuro-vault-mcp.plist`, label `neuro-vault-mcp`, `RunAtLoad`, `KeepAlive` (always — a crash restarts; a clean exit only happens on `bootout`), `StandardOutPath`/`StandardErrorPath` → `~/Library/Logs/neuro-vault/serve.log`; load with `launchctl bootstrap gui/<uid> <plist>`; `restart` = `launchctl kickstart -k gui/<uid>/neuro-vault-mcp`; `uninstall` = `bootout` + delete.
- Linux: `~/.config/systemd/user/neuro-vault-mcp.service`, `Restart=always`, `RestartSec=2`, `WantedBy=default.target`; `install` = write + `daemon-reload` + `enable --now`; `restart` = `systemctl --user restart`; `uninstall` = `disable --now` + delete + `daemon-reload`. Logs: journald (`journalctl --user -u neuro-vault-mcp`). The `loginctl enable-linger` hint is printed, not run.
- Other platforms: exit 1, `service is supported on macOS (launchd) and Linux (systemd --user)`.
- `install` re-runs are idempotent (overwrite + reload). After `install`/`restart` it polls `/health` for up to 10 s and reports the version it answered with, then prints the config snippets (Q9).
- `status` prints: unit file present/absent; daemon answering or not (`/health`); running version vs the installed CLI's own `packageMeta.version`, with `stale — run \`neuro-vault-mcp service restart\`` when they differ; and `unit points at a missing node or script path — re-run \`service install\`` when either path no longer exists (the nvm case, research §6).

`install` takes the same `--vault`/`--model`/`--semantic`/`--port` options as `serve` and bakes them into the unit; `status|restart|uninstall` take none.

### Q9. Client config: print, never write.

mcp-local-hub rewrites client configs and therefore carries backups, rollback and a merge policy (research §4). **Decision:** print, for Claude Code the JSON block with `"type": "http"` plus the `claude mcp add --transport http neuro-vault http://127.0.0.1:7531/mcp` one-liner, and for Cursor/Windsurf the `url` block. Stdio entries stay valid for clients that reject loopback HTTP.

### Q10. Where the CLI grows.

`parseConfig` gains two commands sharing the existing `VAULT_OPTION`/`MODEL_OPTION` and a new `PORT_OPTION` (declared once, used by `serve` and `service install`): `serve` and `service <action>`. `ParsedCli` gains `{ kind: 'serve'; options: ServeCliOptions }` and `{ kind: 'service'; options: ServiceCliOptions }`; `main` gains two branches. `--port` is validated as an integer 1–65535. `$0` and `index` are untouched.

### Q11. What is measured, and where.

The issue asks for RSS and p95 with 3–5 concurrent sessions vs N stdio processes. Source-level tests cannot observe this; it is not a CI gate either (it depends on the model and the vault). **Decision:** PR 2's verify records, on the owner's vault: RSS of one `serve` process after 3 clients have each run 5 `search_notes`, vs the sum of 3 stdio processes after the same calls; and p95 of `search_notes` with 3 clients issuing concurrently, measured by a throwaway script in the session scratchpad. Numbers go into verify.md and the guide's "when to use serve" paragraph, not into a spec.

### Q12. ADR?

A second transport with a different lifecycle, the stateless-sessions call, "loopback only, no auth, no port fallback", and "the daemon handles signals where stdio does not" are each the kind of decision a future reader will ask "why" about. **Decision — propose ADR-0018 "Local daemon over Streamable HTTP: one process per machine, stateless sessions, loopback only"**, written in PR 2; the design artifact asks for the user's ack before it is written. `docs/architecture/http-daemon.md` is the living concept file (serve, health, service); `cli-startup.md`, `mcp-server-shape.md` and `semantic-backend.md` get the pointers (runtime extraction, signal-based disposal).

### Q13. Specs.

New capabilities: `local-http-daemon` (the `serve` command: bind, guard, stateless endpoint, health, collision, teardown, shared backends) and `daemon-service-install` (the `service` subcommand). Modified: `cli-startup-flags` (new commands and `--port` validation), `semantic-backend-lifecycle` ("Background work stops when the server's transport closes" is stdio-specific; the daemon releases on signal and shares one backend set across every request).

### Q14. Tests, by PR.

- PR 1: existing `test/server-modules.test.ts` is the oracle (startup, shutdown chaining, stdin hang-up) and must pass unchanged; new `test/server-runtime.test.ts` asserts one embedder/registry per runtime, `buildMcpServer` registers 14 tools + resources on any `ToolServer`, and `dispose` settles every backend.
- PR 2: `test/http-daemon.test.ts` starts the real listener on port 0 over a fake runtime and drives it with the SDK's own `Client` + `StreamableHTTPClientTransport`: `initialize` → `tools/list` → `tools/call`; two clients concurrently see the same registry; 403 for a foreign `Origin` and for a foreign `Host`; 404 for unknown paths; `/health` shape; `EADDRINUSE` message with an injected probe; SIGTERM path with an injected signal source and a fake runtime whose `dispose` is observed. Config tests for `serve` parsing and `--port` bounds.
- PR 3: generator snapshot tests (plist XML, unit file), runner tests with an injected `execFile` recording the exact command lines per action and platform, `status` logic with injected `fetch`/`existsSync`, config tests for `service <action>`. Loading a real LaunchAgent is manual verify.

## Acceptance

- `npm test && npm run lint && npm run typecheck && npm run build` pass on every PR; the test count never drops.
- PR 1: `git diff` of `server.ts` reads as extraction; stdio behaviour identical (existing tests unchanged).
- PR 2: `neuro-vault-mcp serve --vault <v>` answers `curl 127.0.0.1:7531/health`; Claude Code with `{"type":"http","url":"http://127.0.0.1:7531/mcp"}` and Cursor with `{"url": …}` both list 14 tools and run `search_notes`; two Claude Code sessions at once share one process (one model load, `/health` pid identical); `kill -TERM` exits within 5 s with watchers closed; a second `serve` on the same port exits 1 naming the first.
- PR 3: on macOS, `service install` → `status` reports running + version; `npm run build` then `status` reports stale; `restart` clears it; `uninstall` leaves no plist and no process. systemd path verified on a Linux host or container.
- Docs: ADR-0018, `docs/architecture/http-daemon.md`, guide (installation: "Run one daemon for all your agents"; configuration: `serve`/`service`/`--port`, the "stdio transport only" limitation retired), README feature line.

## Sources

- MCP spec, transports: https://modelcontextprotocol.io/specification/latest/basic/transports
- Claude Code MCP docs (HTTP config, retries): https://code.claude.com/docs/en/mcp
- Claude Code 404 re-initialize bug history: https://github.com/anthropics/claude-code/issues/69310 , https://claudeissues.com/issue/62008-bug-mcp-streamable-http-client-still-does-not-re-initialize-after-http-404-sessi , https://claudeissues.com/issue/75976-bug-v2-1-205-regression-http-mcp-session-404-not-re-initialized-routed-into-oaut , https://claudeissues.com/issue/9608-bug-when-claude-code-receives-http-404-with-a-session-id-error-from-an-mcp-serve
- Multiple clients on one Streamable HTTP server: https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1677
- Cursor Streamable HTTP thread: https://forum.cursor.com/t/connect-streamable-http-on-cursor-mcp/111252
- Prior art, shared local MCP daemon: https://github.com/applicate2628/mcp-local-hub
- Port policy: Syncthing GUI listen address https://docs.syncthing.net/users/guilisten.html ; daemon reuse/EADDRINUSE reports https://github.com/getpaseo/paseo/issues/6313 , https://github.com/thedotmack/claude-mem/issues/1531
- Service install: pm2 startup https://pm2.keymetrics.io/docs/usage/startup/ ; launchd bootstrap/kickstart https://dev.to/mjehanno/launch-a-node-script-at-boot-on-macos-1dnd ; cross-platform service wrapper https://github.com/munogu/node-service

---

## Revision (same day): the shim becomes the default, and the channel becomes a unix socket

Two user questions reopened the shape after the first decision chain: (a) keep stdio outward and let `neuro-vault-mcp` itself find or start the shared process — #145's "Considered: auto-spawning stdio shim"; (b) research how tools that spawn a shared daemon from a CLI actually talk to it, and whether a socket beats HTTP. Both adopted (user ack, 2026-10-14). The change was renamed `shared-vault-daemon`. Q1 (three PRs), Q2 (runtime module), Q6 (signal teardown, listener before warmup), Q11 (measurements in verify), Q12 (ADR), Q14 (tests by PR) stand in spirit; Q3–Q5, Q7–Q10, Q13 (HTTP, ports, Host/Origin guard, health, `service`) are withdrawn — Streamable HTTP moves to #127, where the hub needs it anyway.

### Research 2 — daemon-spawning CLIs, and socket vs HTTP

| Tool | Channel | Discovery | Version mismatch | Idle |
|---|---|---|---|---|
| Nx | unix socket (`/tmp/.nx/<uid>/sockets`), named pipe on Windows | `connect` probe on the socket; pid/version in a cache JSON beside it | treated as "no daemon", a new one is started | 3 h |
| Watchman | unix socket, one JSON PDU per line | `get-sockname`; the CLI spawns the service | — | one per user |
| pm2 | two unix sockets under `~/.pm2` | `connect` probe on `rpc.sock`; `spawn` detached, stdio to a log file, readiness via IPC | — | never |
| Turborepo | unix socket + pid file in tmp | reads the pid file, connects | — | stale pid files are the top complaint |
| Gradle | localhost TCP + a file-locked registry of addresses | registry entry; incompatible → new daemon | one daemon per Gradle version | 3 h |
| Bazel | one server per workspace (output base) | by output base | client stops the old server, starts a new one | 3 h |

Lessons taken: spawn `detached` + `unref`, stdio to a log file, readiness by polling `connect`; local CLI↔daemon channels are overwhelmingly unix sockets / named pipes, TCP-localhost is chosen by JVM tools and anything that must cross a network; identity lives in an info file beside the socket; the recurring bug is a stale socket/pid file — fixed by a `connect` probe (`ECONNREFUSED` → unlink) under a lock file, never by file size or age; macOS caps the socket path at 103 bytes and `$TMPDIR` alone is 48, so use `/tmp/<short>`.

Socket vs HTTP for *this* shim: the MCP spec says a custom transport over a byte stream (unix socket, TCP) SHOULD reuse the stdio framing. The SDK's `StdioServerTransport(stdin?, stdout?)` takes any `Readable`/`Writable`, so a per-connection server over a socket is `new StdioServerTransport(socket, socket)` — no new transport code — and the shim is `stdin.pipe(socket); socket.pipe(stdout)`: a byte pump, no parsing, no SSE, no HTTP retry logic. A connection is a session: each client gets its own `McpServer` over the shared runtime, a disconnect is its teardown, there are no session ids and none of Claude Code's 404 re-initialize bugs, and the daemon knows how many clients it has, so idle counts from the last disconnect rather than the last request. The whole HTTP category of problems — Origin/Host guard, port collisions, `--port` — disappears; access is the socket file's permissions. Cost: stale-socket cleanup, a lock file, the path-length cap, and `\\.\pipe\` on Windows (supported by Node, not verified beyond "falls back cleanly"). Lost: direct `url` connections from Claude Code/Cursor and `curl /health` — neither is needed once the shim is the default, and both belong to #127.

### Q15. Why the shim as the default, and why a socket

It is exactly the goal: `npm i -g` and nothing else — no client config change, no service manager, no platform matrix, no Node-path pitfalls. As the default it fixes the problem for every existing user without a guide. The socket makes the shim trivial and keeps full MCP semantics per client. The guard rail: **any doubt → in-process, as today** (`--no-shared` forces it), so the worst case is current behaviour.

### Q16. One daemon per configuration *and* version; no killing

The socket path is derived from a key = short hash of `{ version, vaults: sorted absolute paths, model key, semantic enabled }`. Consequences: a typical user (one config everywhere) gets one daemon; two different configs get two daemons, each with its own model — still N→2 instead of N, and no "incompatible → fallback" branch at all (Nx/Bazel key per workspace the same way). Including the version means an upgrade never kills a running daemon: new sessions get the new version at once, old sessions keep their old daemon until they end, and it exits on idle. The one overlap risk — a version that changes the embedding model has two daemons reconciling the same corpus for a while — is bounded by the idle timeout and is the same hazard N stdio processes have today; documented, not engineered around (a `daemon stop` exists for the impatient).

### Q17. Paths and files

- POSIX socket: `/tmp/neuro-vault-<uid>/<key>.sock` (directory created `0700`; ~36 bytes, under the 103-byte cap); Windows: `\\.\pipe\neuro-vault-<uid>-<key>`.
- State dir: `<cache>/neuro-vault/daemons/<key>/` where `<cache>` follows the model cache rule (`$XDG_CACHE_HOME` if absolute, else `~/.cache`): `daemon.json` (pid, version, socket path, config, startedAt — written atomically after listen), `daemon.log` (the spawned daemon's stdout+stderr), `daemon.lock` (pid; exclusive create).
- Nothing in a vault; nothing in the repo; nothing world-readable with content beyond vault paths.

### Q18. Daemon lifecycle

`neuro-vault-mcp daemon --vault … [--model] [--no-semantic] [--idle-timeout <min>]` (default 30; 0 = never):
1. Take `daemon.lock` (exclusive create with pid). Exists → read pid: alive → exit 1 "already running"; dead → replace.
2. POSIX: socket file exists → `connect` probe: refused/absent → unlink; connected → exit 1 (another daemon won the race; its clients are fine).
3. `createServerRuntime(config)`; `net.createServer` → `listen(socketPath)`; `chmod 0600`; write `daemon.json`; stderr line; `runtime.warmup()` (listen before warmup, as before).
4. Per connection: `buildMcpServer(runtime)` + `new StdioServerTransport(socket, socket)` + `connect`; on socket close → `transport.close()` (the SDK aborts in-flight handlers), drop from the live set; live set empty → arm the idle timer; a new connection disarms it.
5. Stop (signal, idle, or `daemon stop`): stop accepting, end every client socket, `runtime.dispose()`, remove `daemon.json`, socket file and lock, exit 0; 5 s deadline exits regardless.
6. `daemon status` lists every `daemons/*/daemon.json`, probes each socket, prints version/pid/vaults/alive-or-stale and sweeps stale entries; `daemon stop` sends SIGTERM to each live one.

### Q19. Shim algorithm (`neuro-vault-mcp --vault …`, the default)

```
key ← hash(version, config)
probe connect(socketPath):
  connected                      → pipe
  refused / absent               → spawn daemon (detached, stdio→daemon.log, unref); poll connect every 50 ms ≤ 10 s → pipe
  cli.js is a .ts file (dev run), spawn throws, poll times out, platform error → in-process fallback, one stderr line naming daemon.log
pipe: stdin → socket, socket → stdout; stdin end → socket.end(); socket close before stdin end → exit 1 with a stderr line (daemon died); else exit 0
--no-shared → in-process, silently
```

Spawn race: two shims spawn two daemons; the loser fails at the lock or the live-socket probe and exits 1 into its log; both shims' polls connect to the winner.

### Q20. CLI surface after the revision

- default command: `--vault`, `--model`, `--semantic`, **`--shared`** (boolean, default `true`; `--no-shared` = in-process)
- **`daemon [status|stop]`**: run (`--vault`, `--model`, `--semantic`, `--idle-timeout`), or list / stop known daemons
- `index`: unchanged. No `serve`, no `--port`, no `service`.

### Q21. What is breaking

The default invocation now starts (or joins) a background process per configuration that outlives the session, exits 30 minutes after its last client, and writes a log file under the cache directory. README's "no external processes" is reworded to "one shared background process per vault configuration, started on demand, gone when idle". PR 3 is `feat!:` with a `BREAKING CHANGE:` footer; `--no-shared` is the documented opt-out.

### Q22. Specs after the revision

New: `shared-vault-daemon` (the daemon command: socket, per-connection sessions, lock and stale cleanup, info file, idle exit, teardown, status/stop) and `shared-stdio-shim` (the default stdio behaviour: locate/spawn/pipe, fallback and its reasons, `--no-shared`). Modified: `cli-startup-flags`, `semantic-backend-lifecycle`. `local-http-daemon` and `daemon-service-install` are withdrawn.

### Acceptance (revised)

- PR 1 unchanged.
- PR 2: `neuro-vault-mcp daemon --vault <v>` listens; a raw-line JSON-RPC client over the socket completes `initialize` → `tools/list` (14 tools) → `tools/call`; two concurrent connections share one process; the socket file is `0600`; a stale socket + dead lock are cleaned on the next start; SIGTERM exits within 5 s with watchers closed and files removed; `daemon status` lists it; `--idle-timeout 1` exits a minute after the last client leaves.
- PR 3: two Claude Code sessions with unchanged stdio configs share one daemon pid; `npm run build` then a new session starts a second daemon on the new version while the old sessions keep working; after the old sessions end, the old daemon exits on idle; `--no-shared` runs in-process silently; `npm run dev -- --vault <v>` (tsx) falls back in-process with one stderr line. Measurements (RSS of one daemon with 3 clients vs 3 stdio processes; p95 of `search_notes` with 3 concurrent clients) recorded in verify.
- Docs: ADR-0018, `docs/architecture/shared-daemon.md`, guide (installation, configuration incl. `--no-shared`, the log file, `daemon status|stop`), README feature line.

### Sources (research 2)

- Nx: https://nx.dev/docs/concepts/nx-daemon , https://github.com/nrwl/nx/blob/master/packages/nx/src/daemon/client/client.ts
- Watchman: https://facebook.github.io/watchman/docs/socket-interface.html
- pm2: https://github.com/Unitech/pm2/blob/master/lib/Client.js , https://pm2.keymetrics.io/docs/usage/specifics/
- Gradle: https://docs.gradle.org/current/userguide/gradle_daemon.html · Bazel: https://bazel.build/run/client-server
- Turborepo stale pid/socket reports: https://github.com/vercel/turborepo/discussions/3154
- MCP custom transports over byte streams: https://modelcontextprotocol.io/specification/latest/basic/transports
- Stale unix sockets: https://gist.github.com/visnup/9801864 , https://github.com/sveltejs/kit/pull/16241 ; macOS path cap: https://github.com/anthropics/claude-code/issues/17658 ; Node `net`: https://nodejs.org/api/net.html
- stdio↔HTTP bridges (prior art for the withdrawn HTTP shim): https://www.sourcepulse.org/projects/2335332 , https://github.com/Kiennh/mcp-http-stdio

---

## Revision 2 (same day): the boundary moves to the embedding seam; the daemon is a shared-services process

After research 2 the user re-framed the split: keep every session a full in-process MCP server and share only the *model*, behind the `EmbeddingProvider` interface that ADR-0017 already made provider-agnostic — and design the daemon as a general "shared services" process to which several async facades can attach later (lexical search, the watcher), and keep the provider interface open to a remote embedding API. Adopted (user ack, 2026-10-14); the change was renamed `shared-embedding-daemon`. Two intermediate shapes were weighed and withdrawn the same day — a stateless Streamable HTTP daemon plus `service install` (Q3–Q10, Q13 above), then an MCP-over-socket daemon with a byte-pump stdio shim — because once only the model is shared, nothing MCP-level needs to cross a process boundary. Q1 (PR split, now two PRs), Q6 (listen before warmup; signal teardown), Q11 (measurements in verify), Q12 (ADR) and Q14 (tests by PR) carry over in spirit; the daemon lifecycle below comes from research 2. The runtime split (Q2) is no longer needed.

### Research 2 — daemon-spawning CLIs, and socket vs HTTP

| Tool | Channel | Discovery | Version mismatch | Idle |
|---|---|---|---|---|
| Nx | unix socket (`/tmp/.nx/<uid>/sockets`), named pipe on Windows | `connect` probe on the socket; pid/version in a cache JSON beside it | treated as "no daemon", a new one is started | 3 h |
| Watchman | unix socket, one JSON PDU per line | `get-sockname`; the CLI spawns the service | — | one per user |
| pm2 | two unix sockets under `~/.pm2` | `connect` probe on `rpc.sock`; `spawn` detached, stdio to a log file, readiness via IPC | — | never |
| Turborepo | unix socket + pid file in tmp | reads the pid file, connects | — | stale pid files are the top complaint |
| Gradle | localhost TCP + a file-locked registry of addresses | registry entry; incompatible → new daemon | one daemon per Gradle version | 3 h |
| Bazel | one server per workspace (output base) | by output base | client stops the old server, starts a new one | 3 h |

Lessons taken: spawn `detached` + `unref`, stdio to a log file, readiness by polling `connect`; local CLI↔daemon channels are overwhelmingly unix sockets / named pipes, TCP-localhost is chosen by JVM tools and anything that must cross a network; identity lives in an info file beside the socket; the recurring bug is a stale socket/pid file — fixed by a `connect` probe (`ECONNREFUSED` → unlink) under a lock file, never by file size or age; macOS caps the socket path at 103 bytes and `$TMPDIR` alone is 48, so use `/tmp/<short>`.

Socket vs HTTP: the MCP spec says a custom transport over a byte stream (unix socket, TCP) SHOULD reuse the stdio framing, and the SDK exports that framing (`ReadBuffer`, `serializeMessage`, `deserializeMessage`). A socket needs no ports, no Origin/Host guard (DNS rebinding is a browser problem), no session ids; access is the socket file's mode. The whole HTTP problem class — port collisions, EADDRINUSE diagnosis, Claude Code's recurring failure to re-initialize after a 404 (research 1 §2) — does not exist. Streamable HTTP keeps its place for the hub (#127), where clients really are remote.

Sources: Nx https://nx.dev/docs/concepts/nx-daemon , https://github.com/nrwl/nx/blob/master/packages/nx/src/daemon/client/client.ts · Watchman https://facebook.github.io/watchman/docs/socket-interface.html · pm2 https://github.com/Unitech/pm2/blob/master/lib/Client.js , https://pm2.keymetrics.io/docs/usage/specifics/ · Gradle https://docs.gradle.org/current/userguide/gradle_daemon.html · Bazel https://bazel.build/run/client-server · Turborepo https://github.com/vercel/turborepo/discussions/3154 · MCP transports https://modelcontextprotocol.io/specification/latest/basic/transports · stale sockets https://gist.github.com/visnup/9801864 , https://github.com/sveltejs/kit/pull/16241 · macOS path cap https://github.com/anthropics/claude-code/issues/17658 · Node `net` https://nodejs.org/api/net.html

### Q23. Boundary: what is shared, what stays per session

| Concern | Where | Why |
|---|---|---|
| Model weights, ONNX session, the cross-session embed queue | daemon (`embed` service) | the 400 MB; the one thing every session duplicates for no benefit |
| `McpServer`, tools, registry, corpus snapshot, reconcile, watcher, lexical cache | session, unchanged | no contract or lifecycle change; stdin EOF still disposes everything |
| `EmbeddingProvider` implementation | session-side facade `DaemonEmbeddingProvider` | the seam ADR-0017 built for "a remote provider"; the daemon is the first one |

Not solved by this change and said so: N watchers / reconcile loops (atomic writes keep it safe), N lexical caches, old code in old sessions after an upgrade. Each is a later service behind the same protocol (Q30).

### Q24. Daemon key = package version only; profiles load on demand

Earlier keys included the model profile or the vault set. A shared-services process must be the one place every session of this install attaches to, whatever its vaults or model, so: `key = hash12(version)`; one daemon per installed version per user. The `embed` service keeps `Map<profileKey, { provider, queue }>` and loads a profile on its first `embed.initialize`; a session with another `--model` adds a second model to the same process. Upgrades keep the per-version property: new sessions attach to a new daemon, old sessions keep theirs until it idles out; nothing is killed.

### Q25. Protocol: JSON-RPC 2.0 with namespaced methods, stdio framing

One JSON-RPC 2.0 message per line, using the SDK's exported `ReadBuffer` / `serializeMessage` / `deserializeMessage` (`@modelcontextprotocol/sdk/shared/stdio.js`) on both ends — zero framing code, schema-validated messages. Methods are `<service>.<method>`:

| Method | Params | Result |
|---|---|---|
| `daemon.info` | — | `{ name, version, pid, started_at, idle_timeout_min, clients, services: { embed: { loaded: [profileKey…] } } }` |
| `daemon.shutdown` | — | `{}` then the daemon stops |
| `embed.initialize` | `{ profile }` | `{ identity, max_batch_size }` after the provider is ready |
| `embed.query` | `{ profile, text }` | `{ vector }` |
| `embed.documents` | `{ profile, texts }` | `{ vectors }` (`texts.length ≤ max_batch_size`) |

Errors are JSON-RPC errors with a numeric `code` and `data.code` ∈ `UNKNOWN_METHOD | INVALID_PARAMS | UNKNOWN_PROFILE | EMBED_FAILED | SHUTTING_DOWN`. Vectors travel as JSON number arrays (a 640-d vector ≈ 10 KB of text; a batch of 8 ≈ 100 KB — trivial on a local socket; base64 float32 is the documented optimisation if p95 ever shows it). The daemon's service registry is `namespace → { [method]: handler }`; `lexical.*` or `watch.*` later is one more entry.

### Q26. The facade, its queues, and the fallback

`DaemonEmbeddingProvider implements EmbeddingProvider`:
- `identity = identityOf(profile)` — computed locally; the daemon runs the same code at the same version, so the vectors are the same vectors. `maxBatchSize` comes from the daemon's `embed.initialize` answer (a remote-backed profile has its own limits; the local default applies until then).
- `initialize()` = ensure a connection (locate → spawn if needed → poll) and `embed.initialize`; the server's warmup awaits exactly this, so a cold model loads once, in the daemon.
- `embedQuery` / `embedDocuments` = ensure connection, send with an `id`, await the matching response (per-request timeout: 60 s for a query, 5 min for documents — cold inference can take seconds; a hung daemon must not hang the session forever).
- Socket close → every pending request rejects with `DaemonConnectionError`; the connection is dropped; the next call runs locate/spawn again (the daemon may have idled out, or a newer session may be starting the next version alongside — both fine).
- Fallback: if locate/spawn/poll fails, or the CLI runs from a `.ts` file (dev), the provider switches **once per process** to a local `EmbeddingService` and writes one stderr line naming the daemon log. `--no-shared` picks the local provider up front, silently. An `EMBED_FAILED` answer (the model could not load in the daemon) is surfaced like today's local load failure — retried on the next call — never as a reason to fall back.
- Queues: the session keeps `createQueuedEmbedder` (bucketing, one request in flight per process, queries first); the daemon's per-profile `QueuedEmbedder` orders across sessions, so session B's query jumps ahead of session A's indexing batches. Queue depth in the daemon is bounded by the session count.

### Q27. Lifecycle (carried over, re-keyed)

- POSIX socket `/tmp/neuro-vault-<uid>/<key>.sock` (dir `0700`, file `0600`); Windows `\\.\pipe\neuro-vault-<uid>-<key>`. State `<cache>/neuro-vault/daemons/<key>/{daemon.json, daemon.log, daemon.lock}` with `<cache>` per the model-cache rule.
- `neuro-vault-mcp daemon [--idle-timeout <min>]` (default 30; 0 = never): lock (`wx`, pid; dead holder replaced, live holder → exit 1), stale-socket probe (refused/absent → unlink; listening → exit 1), listen, chmod, write `daemon.json` atomically, one stderr line; no model until a client asks. Per connection: `ReadBuffer`, dispatch, response; client set; idle timer armed when the set empties, disarmed by a new connection. Stop (signal, idle, `daemon.shutdown`): stop accepting, reject in-flight with `SHUTTING_DOWN`, end sockets, remove info file, socket, lock; exit 0; 5 s deadline.
- `daemon status`: every `daemons/*/daemon.json`, probe, `daemon.info` → `version · pid · clients · loaded profiles · alive|stale`, stale entries swept. `daemon stop`: `daemon.shutdown` to each alive one (SIGTERM if it does not answer).
- Spawn (from the facade): `spawn(process.execPath, [cliPath, 'daemon'], { detached: true, stdio: ['ignore', log, log], windowsHide: true })`, `unref`, close the fd, poll `connect` every 50 ms ≤ 10 s. Race: the loser fails at the lock or the live-socket probe and exits into its log; both facades connect to the winner.

### Q28. `index` and eval

`neuro-vault-mcp index` builds its provider through the same factory, so a warm-up run shares the model with a running server — the first visible win of a shared process. `npm run eval` keeps the local `EmbeddingService`: an offline harness must not depend on a daemon's state.

### Q29. Delivery: two PRs, a minor release

| PR | Content |
|---|---|
| 1 `Refs #145` | `src/daemon/`: paths and key, lock, info file, stale probe, protocol + service registry, `embed` service, socket server, idle timer; `neuro-vault-mcp daemon [status\|stop] [--idle-timeout]`; ADR-0018 (after ack); `docs/architecture/shared-daemon.md` |
| 2 `Closes #145` | `DaemonEmbeddingProvider` + connection (locate/spawn/poll, JSON-RPC client), provider factory wired into the server and `index`, `--shared`/`--no-shared`, fallback; docs sweep (guide, README), measurements in verify, retro, archive |

No tool contract changes; a background process appears as an implementation detail of the embedding provider → **minor** version, with release notes that say what runs, where its files are, and how to opt out.

### Q30. How the next services attach (not built here; the protocol is shaped for it)

- `lexical.*`: the session sends `{ vault, query, scope }`, the daemon owns the per-vault lexical cache (`src/lib/obsidian/lexical/`) and returns ranked blocks — removes the +427 MB-per-session cache on large vaults.
- `watch.*`: the daemon owns chokidar + reconcile per vault; sessions keep reading the corpus snapshot from disk as today and may subscribe to "corpus changed" notifications — removes N watchers and N reconcile loops.
Each is its own change; the key (version), the socket, the lifecycle and the framing do not move.

### Q31. A remote embedding provider later (not built here; the seam stays open)

`EmbeddingProvider` is already fully asynchronous and self-describing (`identity`), with query and document embedding as separate calls — the shape a remote API needs (`input_type`). Two choices here keep it open: `maxBatchSize` is what the provider reports, not a constant the caller assumes; and the daemon builds providers for a profile through the same factory the session uses, so a remote profile naturally lives in the daemon — one place for the API key, the rate limit and a response cache — while the session facade is unchanged. What a remote provider will need: an entry in the closed profile registry with its own `identity` (`provider`, `model_id`, `dims`, …) and calibrated similarity thresholds; the manifest already records `provider`.

### Q32. Specs after revision 2

New: `shared-services-daemon` (lifecycle, socket, protocol, service registry, `daemon` command) and `daemon-embedding-provider` (the `embed` service and the session-side facade, queues, fallback, `--no-shared`). Modified: `cli-startup-flags` (`daemon` command, `--shared`), `semantic-backend-lifecycle` ("One embedding model serves the whole process" → one model per machine, queue in the daemon), `embedding-model-profiles` ("One profile serves the whole process" → the process still selects one; its weights may live in the daemon). Withdrawn: everything HTTP, `service`, the MCP-over-socket daemon, the shim.

### Acceptance (revision 2)

- PR 1: `neuro-vault-mcp daemon` listens; a raw JSON-RPC client over the socket gets `daemon.info`, then `embed.initialize {profile: "granite-97m"}` → identity with 384 dims and `max_batch_size`, `embed.query` → a 384-float unit vector, `embed.documents` of 8 texts → 8 vectors; two concurrent connections share one loaded model (`daemon.info.services.embed.loaded` has one entry); a second `daemon` exits 1 at the lock; a stale socket + dead lock are cleaned on the next start; SIGTERM exits within 5 s with files removed; `--idle-timeout 1` exits a minute after the last client; `daemon status` lists it, `daemon stop` ends it.
- PR 2: two Claude Code sessions with unchanged stdio configs → `daemon status` shows one daemon with `clients: 2` and one loaded profile; `search_notes` works in both; `neuro-vault-mcp index` while a server runs loads no second model; `npm run build` then a new session → a second daemon on the new version while old sessions keep working; after old sessions end the old daemon idles out; `--no-shared` loads the model in-process; `npm run dev -- --vault <v>` (tsx) falls back with one stderr line. Measurements in verify: RSS of one daemon + 3 sessions vs 3 stdio processes after 5 `search_notes` each; p95 of `search_notes` with 3 concurrent sessions.
- Docs: ADR-0018, `docs/architecture/shared-daemon.md`, `embedding-pipeline.md` (provider factory), guide (installation: what runs, where the log is; configuration: `--no-shared`, `daemon status|stop`, idle timeout), README.
