## Context

Every MCP client session runs its own `neuro-vault-mcp` over stdio. `startNeuroVaultServer` (`src/server.ts`) builds one `EmbeddingService` (the local transformers.js provider) and wraps it in `createQueuedEmbedder` (query lane ahead of the index lane, length-bucketed batches); `cli-index.ts` builds its own. Measured on 2026-10-14 with harrier-270m (#145): 450–600 MB RSS per session that has embedded a query, 55–85 MB idle — the model is the difference.

The seam already exists: `EmbeddingProvider` (`src/modules/semantic/types.ts`) is `{ identity, maxBatchSize, initialize(), embedQuery(text), embedDocuments(texts) }` — fully asynchronous, self-describing, query and document embedding as separate calls — made provider-agnostic by ADR-0017 so a hub could embed through a remote API. Nothing else in the session needs to change.

Constraints and findings (research, same day):

- Daemon-spawning CLIs (Nx, Watchman, pm2, Gradle, Bazel) converge on: unix socket / named pipe; `spawn` detached + `unref` with stdio to a log; readiness by polling `connect`; identity in an info file beside the socket; a lock file; a `connect` probe (never file size or age) to recognise a stale socket; idle exit after hours. macOS caps a unix socket path at 103 bytes; `$TMPDIR` alone is 48.
- The MCP spec says custom transports over a byte stream SHOULD reuse the stdio framing. The SDK exports `ReadBuffer`, `serializeMessage`, `deserializeMessage` (`shared/stdio.js`), which validate JSON-RPC 2.0 messages.
- Repo invariants: no `exec` with a shell string (ADR-0004); `tsc --noEmit` is the gate; no tool parameter changes (the MCP parameter dictionary is untouched); every tool error is a `ToolHandlerError` (the facade's failures surface through the existing `wrapDependencyError` path, unchanged).
- Settled by the user (2026-10-14): share only the model behind `EmbeddingProvider`; the daemon is a general shared-services process with namespaced methods so lexical search and the watcher can attach later; keep the provider interface open to a remote embedding API; a unix socket, not HTTP; one daemon per installed version; two PRs.

Stakeholders: the owner running several Claude Code / Cursor / desktop-app sessions on one laptop; later, the lexical and watcher services, a remote embedding provider, and the hosted hub (#127).

## Goals / Non-Goals

**Goals:**

- One loaded model per machine per profile, shared by every server session and every `index` run of the installed version.
- Nothing to install or configure; existing client configs keep working; no tool contract change.
- Any doubt resolves to today's in-process behaviour; `--no-shared` forces it.
- A protocol and lifecycle that later services (`lexical.*`, `watch.*`) join without changes, and a provider seam a remote API implements without changes.
- Stale state (socket, info file, lock) is self-healing; `daemon status|stop` is the operator surface.

**Non-Goals:**

- Sharing the registry, corpus snapshot, reconcile, watcher or lexical cache (later changes).
- A remote embedding provider (later; see D9).
- Streamable HTTP, `/health`, authentication, anything network-reachable (#127).
- A service-manager install; Windows beyond "named pipe path, and the facade falls back cleanly".
- Killing older-version daemons.

## Decisions

### D1: The boundary is `EmbeddingProvider`; the daemon hosts namespaced services

- **Choice**: sessions stay full in-process MCP servers. A new `DaemonEmbeddingProvider` implements `EmbeddingProvider`; the daemon exposes an `embed` service (and a `daemon` service for `info`/`shutdown`) through a registry `namespace → { method: handler }`.
- **Rationale**: the model is the duplicated cost; the seam is already there; no lifecycle or contract changes elsewhere. The registry is what lets `lexical.*` and `watch.*` arrive as entries rather than as new protocols.
- **Alternatives**: share the whole MCP server over a socket with a stdio byte-pump shim (closes the watcher and lexical duplication too, but changes the default process model, needs a runtime split and a major version — kept as a later step over the same lifecycle); share nothing and document `--no-semantic` for extra sessions (does not solve the problem).

### D2: Socket channel, JSON-RPC 2.0 messages, SDK framing

- **Choice**: `net.createServer` on `/tmp/neuro-vault-<uid>/<key>.sock` (`\\.\pipe\neuro-vault-<uid>-<key>` on Windows). One JSON-RPC 2.0 message per line, parsed and serialised with the SDK's `ReadBuffer`/`serializeMessage`/`deserializeMessage`. Methods: `daemon.info`, `daemon.shutdown`, `embed.initialize { profile }`, `embed.query { profile, text }`, `embed.documents { profile, texts }`. Errors carry a numeric JSON-RPC `code` and `data.code` ∈ `UNKNOWN_METHOD | INVALID_PARAMS | UNKNOWN_PROFILE | EMBED_FAILED | SHUTTING_DOWN`. Vectors are JSON number arrays.
- **Rationale**: spec-sanctioned framing, zero framing code, schema-validated messages; no ports, no Origin guard, no session ids; the socket mode is the access control. A 640-d vector is ≈ 10 KB of text; a batch of 8 ≈ 100 KB — negligible on a local socket next to inference time.
- **Alternatives**: Streamable HTTP on 127.0.0.1 (the first design: Origin guard, `--port`, EADDRINUSE diagnosis, a retrying bridge — all cost, no benefit once nothing MCP-level is shared; #127 keeps it for the hub); a bespoke binary protocol (premature; base64 float32 is the documented optimisation if p95 ever shows JSON cost).

### D3: Daemon key = package version + CLI build; profiles load on demand

- **Choice**: `key = sha256("v1:" + version + ":" + cliSize + ":" + cliMtimeMs)[0..12]`, where the last two come from `fs.statSync` of the running CLI script; one daemon per installed *build* per user (a symlinked dev install rebuilds without a version bump — see Risks). The `embed` service keeps `Map<profileKey, { provider: EmbeddingProvider, queue: QueuedEmbedder }>`, created on the first `embed.initialize` for that profile through the same provider factory the session uses (D7). State under `<cache>/neuro-vault/daemons/<key>/` (`daemon.json`, `daemon.log`, `daemon.lock`), `<cache>` per the model-cache rule (`$XDG_CACHE_HOME` if absolute, else `~/.cache`).
- **Rationale**: future services are per-vault and must find *the* shared process of this install regardless of a session's vaults or model; profile-on-demand keeps one model per profile per machine. Per-version keying means an upgrade never kills a running daemon: new sessions attach to the new one, old ones keep theirs until it idles out.
- **Alternatives**: key by (version, profile) (a second daemon per profile — fine today, wrong once per-vault services exist); key by vault set (meaningless for a model-only service); kill older daemons on upgrade (disconnects live sessions).

### D4: Lock file plus `connect` probe own stale-state cleanup

- **Choice**: `daemon` creates `daemon.lock` exclusively (`wx`) with its pid; an existing lock's pid is checked with `process.kill(pid, 0)`: alive → exit 1 "already running"; dead → replaced. POSIX: an existing socket file is probed with `connect`: refused/absent → unlinked; listening → exit 1. `daemon status` probes every `daemon.json`'s socket and sweeps the entries that do not answer.
- **Rationale**: the documented failure mode of socket daemons is a stale file; the probe under a lock is the fix the sources agree on; file size is never evidence (a live unix socket also has size 0).
- **Alternatives**: unlink on `EADDRINUSE` without a lock (two starters can delete each other's live socket); pid files as truth (Turborepo's top complaint).

### D5: Lifecycle — no model until asked; idle counts from the last client; signal, idle or `daemon.shutdown` ends it

- **Choice**: `daemon [--idle-timeout <min>]` (default 30; 0 = never): lock → clean → listen → `chmod 0600` → write `daemon.json` atomically → one stderr line. No model loads until a client's `embed.initialize`. The live-connection set drives the idle timer (armed when it empties, disarmed by a new connection). Stop: stop accepting, reject in-flight requests with `SHUTTING_DOWN`, end sockets, remove `daemon.json`, socket and lock, exit 0; a 5 s deadline exits regardless. In-process stdio mode keeps not handling signals (its comment says why); the daemon's comment says why it must.
- **Rationale**: a cheap, model-free listener means the spawn-and-poll wait is short and the first `embed.initialize` carries the real cost exactly once; counting idle from the last disconnect never kills a daemon under a quiet session.
- **Alternatives**: idle from the last request (kills a daemon under an open session; the session would respawn, but needlessly); never exit (daemons accumulate across versions).

### D6: The facade — lazy connection, bounded waits, reconnect, one fallback

- **Choice**: `DaemonEmbeddingProvider({ profile, connection })` with `identity = identityOf(profile)`; `maxBatchSize` is the local provider's value until `embed.initialize` answers, then the daemon's `max_batch_size`. `connection.ensure()` = probe `connect`; on refusal/absence `spawn(process.execPath, [cliPath, 'daemon'], { detached: true, stdio: ['ignore', log, log], windowsHide: true })`, `unref`, close the fd, poll `connect` every 50 ms ≤ 10 s. Requests carry ids and time out (60 s query, 5 min documents). Socket close → pending requests reject with `DaemonConnectionError`; the next call re-runs `ensure()`. Fallback — once per process, with one stderr line naming `daemon.log` — to a local `EmbeddingService` when `ensure()` fails or the CLI path ends in `.ts`. An `EMBED_FAILED` answer is surfaced like today's local load failure (retried on the next call), never as a reason to fall back. `--no-shared` picks the local provider up front, silently. The session keeps `createQueuedEmbedder` around the facade; the daemon's per-profile `QueuedEmbedder` orders across sessions.
- **Rationale**: the worst case equals today; a hung daemon cannot hang a session forever; the spawn race resolves itself (the losing daemon fails at the lock or the live-socket probe and exits into its log; both facades connect to the winner); two queues give per-process serialisation and cross-session query priority with queue depth bounded by the session count.
- **Alternatives**: retry forever (hides a dead daemon); no local queue (loses bucketing and the one-in-flight bound); fail the request instead of falling back (a regression for anyone whose `/tmp` is unusual).

### D7: One provider factory for the server, `index` and the daemon

- **Choice**: `createEmbeddingProvider({ profile, shared, cliPath, env })` in `src/modules/semantic/provider-factory.ts` returns the facade (`shared`) or the local provider for the profile; `server.ts` and `cli-index.ts` call it with `shared` from `--shared` (default `true`, declared once and attached to both commands); the daemon's `embed` service calls it with `shared: false` for each profile it loads. `eval/run.ts` keeps the local `EmbeddingService` (offline harness; must not depend on daemon state).
- **Rationale**: an `index` run while a server is up shares the model instead of loading a second copy; one definition keeps the two invocations copyable, as `--vault`/`--model` already are; the daemon using the same factory is what lets a future remote profile live in the daemon.

### D8: ADR-0018 and the architecture file

- **Proposal (needs the user's ack before it is written, in PR 1)**: `docs/adr/0018-shared-services-daemon.md` — "A shared-services daemon per installed version over a unix socket; the embedding provider is its first client; per-version keying instead of killing". `docs/architecture/shared-daemon.md` is the living concept file (lifecycle, paths, protocol, service registry, the facade, how a new service attaches); `embedding-pipeline.md` gains the provider factory; `semantic-backend.md` and `cli-startup.md` get pointers.

### D9: How a remote embedding provider fits later (shape only, not built)

- **Choice**: `EmbeddingProvider` is kept as the one seam: async throughout, `identity` reported by the provider, query/document as separate calls (a remote API's `input_type`), `maxBatchSize` reported by the provider (D6 reads it from the daemon for the same reason). A remote provider is a profile in the closed registry with `provider: '<api>'` in its identity and calibrated thresholds, built by the factory (D7). Because the daemon builds providers through that factory, a remote profile naturally runs inside the daemon — one place for the API key, the rate limit and a response cache — and the session facade does not change.
- **Rationale**: the user's constraint; ADR-0017's intent; nothing in this change may assume the model is local except `EmbeddingService` itself.

## Risks / Trade-offs

- [Risk] A version that changes the embedding model leaves old sessions (old daemon, old model) and new sessions (new daemon, new model) reconciling the same corpus for a while → Mitigation: bounded by the sessions ending and the idle timeout; writes are atomic; `daemon stop` ends it early. **Observed on 2026-10-14 with N stdio processes**: two pre-v17 sessions (bge-micro-v2) and five v17 sessions (harrier-270m) rebuilt the whole 953-shard corpus against each other on every trigger (a note edit, a new session), all seven embedding at once at ~2 cores each; one process accumulated 78 CPU-minutes. With the daemon the overlap is two processes, not seven, and `daemon status` makes it visible.
- [Risk] The global `neuro-vault-mcp` is a symlink into the repo on the owner's machine, so `npm run build` changes the code behind an unchanged version string; a daemon keyed by version alone would keep serving stale code to new sessions → Mitigation: the key also hashes the CLI script's size and mtime (`fs.statSync(cliPath)`), so a rebuild yields a new daemon and the old one idles out; `daemon.json` records both.
- [Risk] `/tmp` cleaned by the OS while a daemon runs → Mitigation: the next facade's probe finds no socket and spawns a new daemon; the orphan idles out; `daemon status` shows it stale.
- [Risk] Windows named pipes differ → Mitigation: pipe paths have no stale files; any error in locate/spawn/send falls back in-process; not verified further.
- [Risk] JSON vectors cost CPU at high rates → Mitigation: measured in verify (p95 with 3 concurrent sessions); base64 float32 is the documented next step.
- [Risk] A daemon that answers but whose model fails to load (download error) → Mitigation: `embed.initialize` returns `EMBED_FAILED`; the facade surfaces it like today's local failure (retry on the next call), not as a connection failure, so no spurious fallback.
- [Risk] Two profiles loaded in one daemon by two sessions → accepted: still one model per profile per machine; `daemon status` shows `loaded`.
- [Trade-off] N watchers, N reconcile loops and N lexical caches remain → accepted for this change; each is a later service (`watch.*`, `lexical.*`) over the same protocol.
- [Trade-off] A background process the user did not start explicitly → accepted as an embedding-provider implementation detail with a minor release, release notes that say what runs and where, `--no-shared`, and `daemon status|stop`.

## Migration Plan

1. PR 1 ships `daemon` (minor). Nothing uses it yet; `daemon status` works; manual `embed.*` calls possible over the socket for verification.
2. PR 2 flips the provider default (minor). Release notes: what appears under the cache dir, the 30-minute idle exit, `--no-shared`, `daemon status|stop`, `daemon stop` after a model-changing upgrade to end the overlap early.
3. Rollback: `--no-shared` in the client config restores the previous behaviour exactly; `daemon stop` ends any running daemon.

## Open Questions

- ADR-0018: write it (D8)? Asked at the end of this proposal step.
- Measured numbers (RSS of one daemon + 3 sessions vs 3 stdio processes; p95 of `search_notes` with 3 concurrent sessions) are collected in PR 2's verify, not promised in docs beforehand.
