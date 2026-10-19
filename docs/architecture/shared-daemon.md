# The Shared-Services Daemon

One background process per installed build of `neuro-vault-mcp`, shared by every server session and `index` run of that build on the machine. It listens on a local socket, speaks JSON-RPC 2.0 with the MCP stdio framing, and hosts namespaced services. Today it has four real services, `embed`, which holds the embedding model, `vault`, which attaches clients to the shared state of a vault directory ([`vault-entry.md`](./vault-entry.md)), `corpus`, which answers similarity reads over that state, and `lexical`, which answers lexical searches over the vault's cache, plus its own `daemon` service for `info` and `shutdown`. The decisions behind it are [ADR-0018](../adr/0018-shared-services-daemon.md) (the daemon and its embed service) and [ADR-0020](../adr/0020-per-vault-state-in-the-daemon.md) (per-vault state in its vault entries). The code is `src/daemon/` and `src/cli-daemon.ts`.

**Status of the code.** Built and on by default. Every server session and every `index` run embeds through a daemon of its own build, which it finds or spawns on demand ([the session-side facades](#the-session-side-facades)). Every server session also attaches every one of its registered vaults to the daemon's vault entry at startup (a `"semantic": false` vault with no profile), reads a semantically enabled vault's corpus through `corpus.*` and its lexical leg through `lexical.search`, so the daemon holds the watcher, the reconcile loop, the decoded corpus and the lexical cache of every vault once, whatever the number of sessions. A shared session therefore starts the daemon for any registered vault, `"semantic": false` included; `--no-semantic` starts none. `--no-shared` keeps the model and the vault entries in the process.

## What it is

`neuro-vault-mcp daemon [--idle-timeout <min>]` (`runDaemonCommand`, `src/cli-daemon.ts`) takes a lock, cleans up a stale socket, listens, records itself in `daemon.json` and writes one line to stderr:

```
neuro-vault-mcp v<version> daemon listening on /tmp/neuro-vault-<uid>/<key>.sock (idle timeout 30 min)
```

It loads no model and attaches no vault at startup. A model loads the first time a client sends `embed.initialize` for a profile, and stays loaded for the life of the process. The command takes no `--vault` and no `--model`: the daemon belongs to an installed build, not to a vault configuration. Whatever profile a client asks for is the one it loads, so two sessions on different `--model` values share one daemon that holds two models.

The process runs in the foreground of whoever started it. `runDaemonCommand` resolves `0` once the server is listening, and the listening socket keeps the event loop alive. Detaching, `unref` and redirecting stdout and stderr to `daemon.log` are the spawning client's job ([the facades](#the-session-side-facades)), not the daemon's.

## Why it exists

Every MCP client session runs its own stdio `neuro-vault-mcp`, and each one that has served a query holds its own copy of the model. On 2026-10-14 with `harrier-270m` that measured 450–600 MB RSS per session that had embedded a query, against 55–85 MB for an idle one; the model is the difference. With several Claude Code, Cursor and desktop sessions open on one laptop, that is gigabytes for identical weights.

The seam to remove the duplication already existed. `EmbeddingProvider` (`src/modules/semantic/types.ts`) is fully asynchronous and self-describing, with queries and documents as separate calls ([ADR-0017](../adr/0017-embedding-model-profiles.md)), so a provider that forwards to another process needs no change anywhere else in the session.

Per-vault semantic state was the next duplicate. Each session also ran its own watcher and reconcile loop per vault and held that vault's decoded corpus: on the baseline of #158 (a ~955-note vault, `harrier-270m`) each extra semantic session cost about 93 MB over the `--no-semantic` floor for it. The vault entry holds that state once per vault directory ([`vault-entry.md`](./vault-entry.md), [ADR-0020](../adr/0020-per-vault-state-in-the-daemon.md)). The lexical cache was the next member to move into it: each session parsed every note of every vault it searched, so the entry now holds one cache per directory and sessions send it queries ([`lexical-search.md`](./lexical-search.md)).

The shape follows what daemon-spawning CLIs converge on (Nx, Watchman, pm2; Gradle and Bazel for keying): a unix socket or named pipe, the identity in an info file beside it, a lock file, a `connect` probe to recognise a stale socket, and an idle exit. The comparison is in ADR-0018.

## Paths and files

`daemonPaths` (`src/daemon/paths.ts`) derives every path from one key:

```
key = sha256("v1:" + version + ":" + cliSize + ":" + cliMtimeMs).hex[0..12]
```

`version` is `packageMeta.version`. `cliSize` and `cliMtimeMs` come from `fs.statSync` of the realpath of the running CLI script (`cliBuild`). The key is therefore per installed *build*, not per version: the owner's global install is a symlink into the repo, so `npm run build` changes the code behind an unchanged version string, and a daemon keyed by version alone would go on serving the old code to new sessions. A rebuild gets a new key and a new daemon; the old one idles out. `v1` is a layout tag, so a future change to what the key covers cannot collide with today's keys.

| Path | What |
| --- | --- |
| `/tmp/neuro-vault-<uid>/<key>.sock` | POSIX socket. The directory is created `0700`, checked on every start (`ensurePrivateSocketDir`, below), and re-`chmod`ed `0700` in case an older run left it looser; the socket file is `chmod`ed `0600` right after listening. |
| `\\.\pipe\neuro-vault-<uid>-<key>` | Windows named pipe. No file to go stale, so no probe and no unlink. Node has no `getuid` on Windows, so `<uid>` is `-1` for every user, and two users of one machine would race for one pipe name; untested, and any failure there falls back in-process. |
| `<cache>/neuro-vault/daemons/<key>/daemon.lock` | The holder's pid, created exclusively (see Lifecycle). The state directory is created `0700`. |
| `<cache>/neuro-vault/daemons/<key>/daemon.json` | `{ pid, version, socket, started_at, cli_size, cli_mtime_ms }`, written atomically (`write-file-atomic`, temp + rename) after listening. |
| `<cache>/neuro-vault/daemons/<key>/daemon.log` | The daemon's stdout and stderr, appended to by the facade that spawns it (mode `0600`). The daemon writes only to stderr, one line per event, each prefixed `neuro-vault-mcp daemon:`. The events are its start line, each profile load with its time (`loaded granite-97m in 812 ms`), each load failure with its message, each `EMBED_FAILED` while embedding (method, profile and batch size, never the text), a server error, an `onClose` callback that threw, and a startup, dispose or stop failure. The vault entries' own warnings (a corpus that went `unavailable`, a rebuild, a watcher failure, the lines a session would write to its stderr) go to the same file as they are, without the prefix. A daemon started by hand logs to its terminal instead. |

`<cache>/neuro-vault` is `neuroVaultCacheBase` (`src/lib/cache-dir.ts`): `$XDG_CACHE_HOME/neuro-vault` when `XDG_CACHE_HOME` is an absolute path, else `~/.cache/neuro-vault`. It is the same rule as the model cache, so the two always sit side by side.

The socket lives under `/tmp`, not `os.tmpdir()`. macOS caps a unix socket path at 103 bytes, and its per-user `$TMPDIR` is 48 bytes on its own; `/tmp/neuro-vault-501/<12 hex>.sock` is 38. A client computes the socket path from its own key; `daemon status`, which looks at every key, reads it from `daemon.json`.

`/tmp` is shared, and the directory name is predictable, so another local user can create `/tmp/neuro-vault-<uid>` first, as a symlink to a directory they control or as a directory of their own. `mkdir -p` accepts both. `ensurePrivateSocketDir` (`src/daemon/socket-dir.ts`) therefore `lstat`s the path after creating it: it must be a real directory, not a symlink, owned by our uid, and the `chmod 0700` must succeed. Anything else and the daemon refuses to start, naming the path and what is wrong (`is a symlink`, `is owned by uid N`, `is not a directory`, or the `chmod` error). On Windows there is no directory and no check. The facade runs the same check before every connect: a directory that fails it makes the session fall back in-process rather than connect to a socket someone else controls.

## Lifecycle

### Start

`runDaemon` in `src/cli-daemon.ts`, in order:

1. **Identify the build.** `cliBuild(realpathSync(process.argv[1]))`. If the script cannot be read, exit 1 naming it.
2. **Take the lock** (`acquireLock`, `src/daemon/lock.ts`). The lock is published atomically: the pid is written to a private temp file, which is then hard-linked into place, so `link(2)` fails with `EEXIST` if a lock exists and no reader ever sees a half-written file. An existing lock's pid is checked with `process.kill(pid, 0)` (`EPERM` counts as alive). A live holder → exit 1, `daemon is already running (pid N)`, followed by the lock path and a pointer to `daemon status` (a crashed daemon whose pid was reused by another process keeps that message until its lock is removed). A dead holder, or a lock that names no pid, is replaced by rename-and-verify: the lock is moved to a private path and its content compared with what was judged. If it is the same dead lock, it is dropped and the create retried. If another starter published a fresh lock in between, the moved file is put back with a hard link, and the result is `held` or `contended`. Three attempts; after that, `contended` → exit 1, "try again".
3. **Prepare the socket** (POSIX only). Create, check and tighten the `/tmp/neuro-vault-<uid>` directory (`ensurePrivateSocketDir`; a directory that fails the check is a startup failure, below), then `cleanStaleSocket` (`src/daemon/probe.ts`). The probe deletes the socket file only after `ECONNREFUSED`: the file exists and nobody answers. `ENOENT` means there is nothing to delete. Every other outcome counts as listening: any other error code, a missing code, a synchronous throw, a connect that neither succeeds nor fails within 500 ms. An ambiguous answer must never lead to a live socket being unlinked. File size and age are never evidence; a live unix socket also has size 0. If something listens, the lock is released and the process exits 1, `already listening on <socket>`.
4. **Listen** (`startDaemonServer`, `src/daemon/socket-server.ts`), `chmod 0600` the socket (the `0700` directory covers the window between listen and chmod), write `daemon.json`, register the `SIGINT`/`SIGTERM` handlers, print the start line.

Any failure after the lock is taken closes the server if it was listening, releases the lock and exits 1 with `daemon failed to start: …`. `releaseLock` removes the lock only when it names our own pid, so a failing starter never deletes the winner's lock.

Two daemons racing for one key almost always resolve at the lock: the loser exits 1 without touching the winner's files. The lock is not airtight: `acquireLock` documents a narrow window, while it replaces a dead holder's lock, in which both starters can come away believing they hold it. The live-socket probe and `listen()`'s `EADDRINUSE` are the further lines of defence; either one sends the second starter down the failure path, and `releaseLock` leaves a lock naming another pid alone.

### Idle

The server tracks its *clients*. A connection becomes a client with its first request outside the `daemon.` namespace (an `embed.*` or `vault.*` call, say); one that only calls `daemon.info` or `daemon.shutdown`, as `daemon status` and `daemon stop` do, never becomes one. So polling a daemon with `status` neither keeps it alive nor shows up in its `clients` count, and `daemon.info` never counts the connection asking. The idle timer (`--idle-timeout`, default 30 minutes, `0` = never) is armed as soon as the server is listening, so a daemon nobody ever uses also idles out. The first client disarms it, and the last client to close re-arms it; a connection that never became a client touches it neither way. A client that stays open but sends nothing more keeps the daemon alive: idle counts from the last client, not the last request, so a quiet session never loses its daemon underneath it. When the timer fires, the daemon checks the client count once more (a client that arrived in the same loop turn wins) and stops.

### Stop

There is one stop routine (`createStop`, `src/cli-daemon.ts`), reached from `SIGINT`, `SIGTERM`, idle expiry and `daemon.shutdown`. It runs once:

1. Arm a 5 s deadline (`STOP_DEADLINE_MS`) that exits 0 regardless, so a peer that never reads cannot hold the process.
2. Enter the shutting-down state (`DaemonServerHandle.beginClose()`): stop accepting; answer every in-flight request with `SHUTTING_DOWN` (a handler that finishes later has its answer suppressed); requests that arrive on open connections from now on also get `SHUTTING_DOWN`. Nothing is ended yet.
3. Dispose the vault entries (`VaultEntries.dispose()`): every watcher closes, every reconcile pass in flight is aborted and settled, every corpus is freed. This is why step 2 comes first: a request that arrives while the entries are going away is answered `SHUTTING_DOWN` rather than served from them. A dispose that fails is reported on stderr (`dispose failed: …`) and the stop goes on.
4. Close the server: ending the sockets is deferred one I/O turn, so lines already received are answered rather than dropped on an ended socket. Each socket is destroyed once its write side has flushed, and the close resolves once every connection's `close` handler (and so its `onClose` callbacks) has run.
5. Remove `daemon.json`, then the socket file (POSIX), then the lock. The lock goes last: until it is gone, no new daemon can take this socket path. A removal that fails is reported on stderr and does not stop the rest.
6. Exit 0.

`daemon.shutdown` answers `{}` first; the stop routine is scheduled on the next timer tick, so the reply is written before the connections end.

### Why the daemon handles signals and the stdio server does not

The stdio server deliberately handles no signals ([`mcp-server-shape.md`](./mcp-server-shape.md)): its client hangs up by closing stdin, `SIGINT`/`SIGTERM` terminate it by default, and every corpus write is atomic, so an abrupt end corrupts nothing. The daemon has no stdin to end on. A signal and the idle timer are the only ways it hears to stop, and it owns three files that describe it. Exiting on the default handler would leave the lock, the socket and `daemon.json` behind for the next start and `daemon status` to clean up, and would cut in-flight requests off with a closed socket instead of a `SHUTTING_DOWN` answer the client can tell apart from a crash.

### `daemon status` and `daemon stop`

Both live in `src/daemon/admin.ts`, print their reports to stdout and always exit 0, printing `no daemon known` when there is nothing to report. They work across builds: they scan every `daemons/*` directory, not only the current key's. Each directory is handled on its own: one that cannot be read (a lock that fails with `EACCES` or `EISDIR`, say) is reported on stderr as `<key>: <message>`, is never swept, and the next one goes on.

`daemon status` prints one line per directory:

| Situation | Printed | State directory |
| --- | --- | --- |
| Socket answers `daemon.info` | `<version>  pid <pid>  clients <n>  loaded [<profiles>]  alive  <socket>`, then the vault lines below | kept |
| Socket refuses or is absent, lock names another live pid | `<version>  pid <holder>  starting` (a new daemon for the key has taken over a crashed one's entry and has not written its info yet) | kept |
| Socket refuses or is absent otherwise | `<version>  pid <pid>  stale  (swept)` | removed |
| Socket counts as listening but `daemon.info` gets no answer within 2 s (`CALL_TIMEOUT_MS`) | `<version>  pid <pid>  busy (no answer)  <socket>` | kept |
| `daemon.json` unreadable, lock names a live pid | `<key>  starting` (a daemon between taking the lock and writing its info) | kept |
| `daemon.json` unreadable otherwise | `<key>  stale (unreadable daemon.json)  (swept)` | removed |
| No `daemon.json`, lock names a live pid | `<key>  starting` (as above, or a daemon at the end of a clean stop) | kept |
| No `daemon.json`, lock names a dead pid or none | `<key>  stale (lock only)  (swept)` | removed |
| Nothing in the directory at all | nothing | removed |
| Neither `daemon.json` nor a lock, but other files (`daemon.log`: the last run's log, or a spawner's log opened before its daemon takes the lock) | nothing | kept, untouched |

`clients` counts the daemon's clients, not its connections: `status`'s own connection is not one (see Idle).

**Vault lines.** Under an `alive` line, `status` prints what `daemon.info` reports for the vault service: one indented line per vault entry, then one more indented line per profile attached to it (`vaultLine` and `profileLine`, `src/daemon/admin.ts`):

```
17.2.0  pid 4242  clients 2  loaded [harrier-270m]  alive  /tmp/neuro-vault-501/<key>.sock
  vault /vaults/notes  clients 2
    harrier-270m  ready  955 notes  last reconcile 2026-10-16T09:00:00.000Z +1 ~0 -0 340 ms
  vault /vaults/work  idle 1h 5m (since 2026-10-16T08:55:00.000Z)
    harrier-270m  indexing 120/840
```

Each vault line is followed by one `lexical` line for its cache, before the profile lines:

```
  vault /vaults/notes  clients 2
    lexical  ready  955 notes  last refresh 2026-10-16T09:00:05.000Z ~0 parsed 41 ms
    harrier-270m  ready  955 notes  last reconcile 2026-10-16T09:00:00.000Z +1 ~0 -0 340 ms
  vault /vaults/archive  clients 1
    lexical  warming
```

A vault line is `vault <realpath>  clients <n>`, or, when it has none, how long it has been idle and since when: `idle <m>m (since <iso time>)`, or `idle <h>h <m>m (…)` past an hour. The `lexical` line is `lexical  warming` until the entry's first refresh completes, then `lexical  ready  <n> notes  last refresh <iso time> ~<parsed> parsed <ms> ms`; a daemon that answers without `lexical`, or with a shape this build does not recognise, prints no such line. A profile line is the profile key, then its state: `indexing <indexed>/<total>`, `ready` followed by `<n> notes` once the corpus is loaded, `unavailable` followed by the reason, or `disabled`; and, once a pass has finished, `last reconcile <iso time> +<added> ~<changed> -<removed> <ms> ms`. A daemon of another version answers without a `vault` key, or with a different shape; `status` prints the lines it recognises and never fails on the rest.

A lock that names the `daemon.json` pid counts as stale even when that pid is alive: the daemon behind that entry is not listening, so a live process with its pid is a reused pid. A live lock under a no-`daemon.json` directory is always `starting`; a reused pid there keeps it until the process ends.

**Sweeping happens under the lock.** Judging an entry stale and removing its directory are two steps, and a new daemon for the key can take the lock in between. So `status` first takes the lock over with `claimLock` (`src/daemon/lock.ts`), the same rename-and-verify `acquireLock` uses: it succeeds only if the lock still holds exactly what `status` judged (or, with no lock judged, if none has appeared), and writes `status`'s own pid into it. Only then is the directory removed, our lock with it. If the claim fails, the entry is kept and printed `starting` with whoever holds the lock now (`?` when the lock names no pid).

`daemon stop` probes the socket of every readable `daemon.json`. A daemon that is not listening is reported `not running` and left for `status` to sweep, or, when its lock names another live pid, reported as `<version> (pid <holder>)  starting — not stopped; run \`neuro-vault-mcp daemon stop\` again`. Every other `starting` directory (unreadable `daemon.json` or no `daemon.json`, under a live lock) gets the same line with its key. Stale directories are left alone. A listening daemon gets `daemon.shutdown`. If that gets no answer, `stop` sends `SIGTERM` only when the lock names the `daemon.json` pid and that pid is alive; `daemon.json` can be stale (a reused pid, or a new daemon on the socket that has not rewritten it yet), so otherwise it writes `daemon <version> (pid N) did not answer; not signalling pid N (lock names <holder or none>)` to stderr and moves on. It then waits up to 6 s (`STOP_WAIT_MS`, the daemon's own 5 s deadline plus slack) for `daemon.json` to disappear, the last thing a stopping daemon does before releasing its lock, and prints `stopped <version> (pid N)`, or a `still running` line on stderr. A `SIGTERM` that throws is reported on stderr as `could not signal daemon <version> (pid N): <message>`. `stop` prints `no daemon known` only when it reported nothing at all.

## Protocol

Each connection carries JSON-RPC 2.0 messages, one per line, framed exactly as the MCP stdio transport frames them: the SDK's `ReadBuffer` and `serializeMessage` (`@modelcontextprotocol/sdk/shared/stdio.js`), with one `ReadBuffer` per connection. `ReadBuffer.readMessage` validates each line against the SDK's JSON-RPC schema, so the daemon has no framing or message-shape code of its own. The MCP spec says a custom transport over a byte stream SHOULD reuse this framing.

A line that is not a valid JSON-RPC message destroys that connection and touches no other. So does a line that outgrows the SDK's `ReadBuffer` size cap (10 MiB by default from SDK 1.30, where `append` throws): the daemon destroys that connection, and a session drops its socket and rejects its pending requests with `DaemonConnectionError`. Notifications and responses a client sends are ignored: the daemon serves requests only. Responses go out in whatever order the handlers finish, matched by `id`.

Methods are `<service>.<method>`, routed by `ServiceRegistry` (`src/daemon/protocol.ts`), a map `namespace → { method: handler }`. Only a handler's own properties resolve, so `embed.toString` is an unknown method.

Each method's params are one closed zod object (`z.strictObject`) in `protocol.ts`, beside its result type, and the wire param type is `z.infer` of it, so the `VaultMethods` rows a session calls through and the handler that answers read the same type. The schema owns every constraint it can express, as the MCP tool gate's does one layer up ([ADR-0015](../adr/0015-input-gate-owns-schema-validation.md)). A service builds each handler with `defineMethod({ params, handler })`, which parses the params before `handler` sees them. A mismatch is `INVALID_PARAMS`: the message names each issue as `<path>: <message>`, joined by `; ` (`<root>` for the params object itself, as in `<root>: Unrecognized key: "x"`), and `data.issues` lists them as `{ path, message, expected? }`, the shape the tool gate reports (`formatZodError`, `src/lib/zod-issues.ts`). The parse lives in the handler, not in `dispatch`, because the in-process loopback calls the same handlers past `dispatch` ([The session-side facades](#the-session-side-facades)): both paths validate alike. A check that needs runtime state runs in the handler after the parse: a known profile (`UNKNOWN_PROFILE`), a vector anchor as wide as the corpus, a batch within the provider's `max_batch_size`. `daemon.info` and `daemon.shutdown` read no params and have no schema.

| Method | Params | Result |
| --- | --- | --- |
| `daemon.info` | — | `{ name, version, pid, started_at, idle_timeout_min, clients, services: { embed: { loaded: [profileKey…] }, vault: IVaultInfo[] } }`; `clients` counts client connections only (see Idle); `IVaultInfo` is [below](#reporting-vault-state) |
| `daemon.shutdown` | — | `{}`, then the daemon stops |
| `embed.initialize` | `{ profile }` | `{ identity, max_batch_size }`, once the profile's provider is ready |
| `embed.query` | `{ profile, text }` | `{ vector }` |
| `embed.documents` | `{ profile, texts }` | `{ vectors }`, with `texts.length ≤ max_batch_size` |
| `vault.attach` | `{ vault, profiles }` | `{ vault, profiles: { [profile]: BackendStatus } }`, without waiting for any load or pass ([The vault service](#the-vault-service)) |
| `vault.status` | `{ vault, profile }` | the profile's `BackendStatus`, for a pair this connection attached |
| `corpus.nearest` | `{ vault, profile, anchors, threshold, limit?, allowed?, exclude? }` | `{ hits: ({ path, similarity }[] \| null)[] }`, one list per anchor ([The corpus service](#the-corpus-service)) |
| `corpus.nearestBlocks` | `{ vault, profile, anchors, paths, threshold, limit? }` | `{ hits: ({ path, heading, lines, similarity }[] \| null)[] }` |
| `lexical.search` | `{ vault, queries, allowed?, note_cap, per_note_cap }` | `{ notes: { path, matches, matched_queries }[], truncated, per_query_counts, per_query_token_counts, total_notes }` ([The lexical service](#the-lexical-service)) |
| `graph.noteLinks` | `{ vault, path }` | `{ incoming: { source }[], outgoing: { target, resolved, path? }[] }` ([The graph service](#the-graph-service)) |
| `graph.backlinkCounts` | `{ vault, paths }` | `{ counts: number[] }`, one per path, in order |
| `graph.resolve` | `{ vault, targets }` | `{ paths: (string \| null)[] }`, one per normalized target, in order |

Vectors are JSON number arrays. A 640-dimension vector is about 10 KB of text and a batch of 8 about 100 KB, negligible on a local socket next to inference time. Base64 float32 is the documented next step if measurements ever show JSON cost.

Errors are JSON-RPC errors with a numeric `code` and the daemon's own code in `data.code`, beside any other fields the error carries in `data` ([below](#connection-context-and-error-data)):

| `data.code` | JSON-RPC `code` | When |
| --- | --- | --- |
| `UNKNOWN_METHOD` | -32601 | No such namespace or method. The connection stays open. |
| `INVALID_PARAMS` | -32602 | Params that fail the method's schema (not an object, a wrong type, a missing or unexpected key, blank text, empty `texts`, a relative `vault` in `vault.attach`), with `data.issues`; or a handler's runtime check: more `texts` than `max_batch_size`, a vector anchor narrower or wider than the corpus |
| `UNKNOWN_PROFILE` | -32602 | `profile` (or a key of `profiles`) is not a key of the closed registry (`MODEL_PROFILES`) |
| `NOT_ATTACHED` | -32602 | `vault.status` or `corpus.*` for a vault and profile this connection did not attach; `lexical.search` or `graph.*` for a vault this connection did not attach (with any profiles, or none) |
| `VAULT_UNAVAILABLE` | -32602 | `vault.attach` of a path that cannot be resolved or is not a directory; the message names the reason (a relative path is `INVALID_PARAMS`) |
| `CORPUS_NOT_READY` | -32603 | `corpus.*` while the profile is not `ready`; `data.status` is its `BackendStatus` |
| `CORPUS_FAILED` | -32603 | A `corpus.*` read threw inside the corpus; the message is the reason |
| `LEXICAL_FAILED` | -32603 | A `lexical.search` threw inside the entry (the scan, a refresh or the ranking); the message is the reason |
| `GRAPH_FAILED` | -32603 | A `graph.*` read threw inside the entry (a failed scan or build); the message is the reason. An entry that was dropped answers `NOT_ATTACHED`: its record goes before it is disposed |
| `EMBED_FAILED` | -32603 | The model failed to load, inference threw, or a vector came back non-finite |
| `SHUTTING_DOWN` | -32000 | The request was in flight, or arrived, while the daemon was stopping |
| `INTERNAL` | -32603 | A handler threw something other than a `DaemonRpcError` |

## The embed service

`createEmbedService` (`src/daemon/services/embed.ts`) keeps one entry per profile, built on that profile's first request: a provider and a `createQueuedEmbedder` queue around it. The provider comes from the same factory the session uses, with `shared: false` (`daemonProviderFor` in `src/cli-daemon.ts`, calling `createEmbeddingProvider` in `src/modules/semantic/provider-factory.ts`), so it is always the local `EmbeddingService`: a shared provider here would be a facade onto this daemon itself. Two concurrent first requests for one profile share a single load. Any `embed.*` method loads the profile on first use; `embed.initialize` exists so a client can pay that cost up front and learn the identity and batch size.

The queue is the same two-lane queue a session uses ([`semantic-backend.md`](./semantic-backend.md#the-embed-queue)), so query-first ordering holds between sessions, not only inside one: a session's query waits for at most the one batch in flight, not for any vault's queued indexing. Each client keeps its own queue in front of the facade, with one request in flight, and the vault entries index through the same queue (`documentsFor`, below).

`EMBED_FAILED` is not a connection failure. A load that fails is dropped from the in-flight memo and never enters the loaded set, so the next request for that profile builds and initializes a fresh provider. This is the same retry-on-next-call behaviour as today's in-process load failure, and it is why the facade surfaces `EMBED_FAILED` as an error rather than fall back to an in-process model.

A reconcile pass reaches the model through `documentsFor`, one batch per note, so a model that cannot load would be rebuilt and logged for every batch. `documentsFor` therefore remembers a failed load for `LOAD_FAILURE_MEMO_MS` (30 s) and rejects with the same error meanwhile, with one log line per failure. `embed.initialize` and `embed.query` are not held back: their next call still retries.

Every load and failure also leaves one line in the daemon's log, because the client that asked is often not the one a user looks at. `createEmbedService` takes a `log(line)` dependency, and `startServing` wires it to stderr with the daemon's prefix. It logs `loaded <profile> in N ms` once per load, however many requests shared it, and `failed to load <profile> after N ms: <message>` for a failed load. A request that fails because its load failed adds no second line. An `EMBED_FAILED` raised while embedding logs `embed.query failed for <profile>: <message>` or `embed.documents failed for <profile> (N texts): <message>`. Requests rejected before any embedding (`INVALID_PARAMS`, `UNKNOWN_PROFILE`) are not logged. No line carries query or document text. There are no levels and no rotation; a run adds a handful of lines to `daemon.log` unless embedding keeps failing.

`daemon.info` reports `services.embed.loaded`, the profile keys loaded so far; `daemon status` prints it.

## The vault service

`createVaultService` (`src/daemon/services/vault.ts`) serves `vault.attach` and `vault.status` over the daemon's `VaultEntries` ([`vault-entry.md`](./vault-entry.md) has what they do: validation order, the scope re-read, idle, the loop). `startServing` builds the entries with `embedderFor` wired to the embed service's documents lane (`embed.documentsFor(profileKey)`: the same load and queue `embed.documents` uses, without the wire checks, and the profile loads on its first embed, not at attach) and with the daemon's own `--idle-timeout` as the idle time of an entry or profile nobody is attached to.

- The params are strict: `vault.attach` carries exactly `{ vault: string, profiles: string[] }` and `vault.status` exactly `{ vault: string, profile: string }`. Any other key is `INVALID_PARAMS` — the scope, the exclusions and the corpus identity are the daemon's to read from the vault, never the client's. Every daemon method's params are closed the same way, by its schema ([Protocol](#protocol)): `embed.initialize` takes `{ profile }`, `embed.query` `{ profile, text }` and `embed.documents` `{ profile, texts }`.
- `vault.status` is a read of the entry's state for a pair *this connection* attached; the vault must be addressed by the realpath `vault.attach` returned.
- **No `vault.detach`.** A connection that closes detaches itself from everything it attached. The service hooks `ctx.onClose` the first time a connection calls `vault.attach`, before the attach awaits anything, so a connection that closes mid-attach still detaches.
- A `VaultEntryError` (`NOT_ATTACHED`, `VAULT_UNAVAILABLE`, `UNKNOWN_PROFILE`) keeps its code and message on the wire; anything else is `INTERNAL`.
- `vault.*` calls make the connection a client like `embed.*` calls (see Idle), so an attached session holds the daemon open.
- A `VaultEntryError` is mapped by `wired` (`src/daemon/services/wired.ts`), shared with the corpus service.

### Connection context and error `data`

A handler is `(params, ctx: IConnectionContext) => Promise<unknown>` (`src/daemon/protocol.ts`). `startDaemonServer` creates one context per accepted socket, `{ id, onClose(fn) }`, and `ServiceRegistry.dispatch(request, ctx)` passes it through; `embed.*` and `daemon.*` ignore it. `id` is unique for the life of the server. Callbacks given to `onClose` run once when the socket closes, however it closes; one registered after the close runs at once; a callback that throws is written to the daemon's log and the rest still run. Closing the server resolves only after every connection's callbacks have run, so a stop never leaves an entry thinking a closed client is attached.

`DaemonRpcError` takes an optional `data` object, and `errorResponse` merges it into the response's `error.data` *beside* `code`: `{ ...data, code }`, with `code` last, because the stable code name is the contract and `data` only adds to it. Today only `CORPUS_NOT_READY` sets it, to carry the profile's status (`data.status`) without a second round trip. The session's `DaemonConnection` surfaces it as `DaemonRpcError.data`.

### Reporting vault state

`daemon.info` reports `services.vault`, one `IVaultInfo` per entry, in the order the entries were created:

```typescript
IVaultInfo = {
  vault: string,          // the realpath key
  clients: number,        // connections attached to the entry
  idle_since?: string,    // ISO time; present only while clients is 0
  lexical: { state: 'warming' } | { state: 'ready', notes: number, last_refresh: { at: string, parsed: number, ms: number } },
  profiles: Array<{
    profile: string,
    state: 'ready' | 'indexing' | 'disabled' | 'unavailable',
    indexed?: number, total?: number,   // while indexing
    reason?: string,                    // while unavailable
    notes?: number,                     // ready: notes with a vector
    last_reconcile?: { at: string, added: number, changed: number, removed: number, ms: number },
  }>,
}
```

`lexical.notes` is the cache's note count and `last_refresh` its latest refresh (`parsed` notes re-parsed, `ms` taken). `added` counts notes embedded that had no record, `changed` the other embeds plus renames, `removed` the swept shards. `daemon status` prints it as the indented [vault lines](#daemon-status-and-daemon-stop) under the daemon's own line. It is the operator's only view of the shared state.

## The corpus service

`createCorpusService` (`src/daemon/services/corpus.ts`) serves `corpus.nearest` and `corpus.nearestBlocks` through `VaultEntries.reader(clientId, vault, profile)`; the reader folds the vault's scope into the read ([`vault-entry.md`](./vault-entry.md)). The daemon answers one similarity read per call and never a vector: a hit carries a path, a similarity and, for a block, its heading and lines.

- Params are snake_case and closed (`corpusNearestParams`, `corpusNearestBlocksParams`). An anchor is exactly one of `{ vector: number[] }` (finite numbers) or `{ path: string }`; `limit`, when sent, is a non-negative integer. `corpus.nearest` alone takes `allowed` and `exclude`, `corpus.nearestBlocks` alone `paths`.
- The checks run in a fixed order, each answering its own code: the shape of the params (`INVALID_PARAMS`), the profile key (`UNKNOWN_PROFILE`), the attachment of the pair on this connection (`NOT_ATTACHED`), the profile being `ready` (`CORPUS_NOT_READY` with `data.status`), the width of each vector anchor against the corpus's dimension (`INVALID_PARAMS`), and last the read itself (`CORPUS_FAILED`). The profile is checked before the attachment because an unknown profile can never have been attached.
- `hits` holds one entry per anchor, in order: `null` for a path anchor whose note has no vector, `[]` when nothing reaches the threshold. The corpus yields to the event loop between the anchors of one call (`ShardCorpus`), so a large `find_duplicates` batch does not starve other connections.

## The lexical service

`createLexicalService` (`src/daemon/services/lexical.ts`) serves `lexical.search` through `VaultEntries.lexical(clientId, vault)`, which runs the entry's `lexicalSearch` ([`lexical-search.md`](./lexical-search.md)). The call carries no profile: the cache belongs to the entry, so any connection that attached the vault may search it, even one that attached it with `profiles: []`.

- Params are snake_case and closed (`lexicalSearchParams`): `queries` a non-empty array of strings, `allowed` an optional array of vault-relative paths (absent is no filter, an empty list a filter that matches nothing), `note_cap` and `per_note_cap` positive integers; anything else is `INVALID_PARAMS`. The result keys are snake_case: `notes[]` (`path`, `matches`, `matched_queries`), `truncated`, `per_query_counts`, `per_query_token_counts`, `total_notes`.
- The checks run in a fixed order: the shape of the params (`INVALID_PARAMS`), the attachment of the vault on this connection (`NOT_ATTACHED`, through `wired`), then the search itself, whose throw is `LEXICAL_FAILED` with the reason. `NOT_ATTACHED` is entry-level here, unlike `corpus.*`'s pair check.
- `lexical.*` calls make the connection a client like `embed.*` and `vault.*` calls. The daemon enforces no deadline of its own; the session gives up after 30 s.
- A search never waits on the watcher or a reconcile pass, and it is correct on an entry that has neither a watcher nor a corpus.

## The graph service

`createGraphService` (`src/daemon/services/graph.ts`) serves `graph.noteLinks`, `graph.backlinkCounts` and `graph.resolve` through `VaultEntries.graph(clientId, vault)`, the entry's one wikilink graph as an `IGraphReader` ([`wikilink-graph.md`](./wikilink-graph.md#reading-a-graph-from-elsewhere-igraphreader)). Like `lexical.search`, the calls carry no profile: any connection that attached the vault may read its graph, even one that attached it with `profiles: []`.

- Params are closed (`graphNoteLinksParams`, `graphBacklinkCountsParams`, `graphResolveParams`): `path` a string, `paths` and `targets` arrays of strings, each target already normalized. An empty `paths` or `targets` is valid and answers an empty list. A note the graph does not hold has no links and a count of 0.
- The checks run in a fixed order: the shape of the params (`INVALID_PARAMS`), the attachment of the vault on this connection (`NOT_ATTACHED`, through `wired`), then the read, whose throw is `GRAPH_FAILED` with the reason.
- Each read awaits the graph's `ensureFresh()`: it answers from a build at most the TTL (3 min) old, and waits for a rebuild when the last one is older. The session gives up after 30 s.
- The daemon serves reads only. Ranking by backlinks, `query_notes`' filters and a note's forward links are composed in the session from these answers.

## The session-side facades

A process reaches the daemon through **one connection and one switch**, shared by the embedding provider and every vault client it runs. `createSharedServices` (`src/modules/semantic/shared-services.ts`) builds that `ISharedServices` once per process: the server builds it in `startNeuroVaultServer` and hands it to both the embedding provider and the vault clients (`createVaultClients`); `index` builds its own for its embedding provider. It is called with the realpath of the running `cli.js`, which `src/cli.ts` resolves once and passes to every command, and it computes the same key the daemon computes for itself: version, plus that file's size and mtime. Construction only stats that file; it probes, spawns and creates nothing. `ISharedServices` holds the `DaemonConnection` (`src/modules/semantic/daemon-connection.ts`) and the switch `mode`: `pending` until the first `ensure()` settles, then `daemon` or `local`; `local` is final, and `--no-shared` starts there with no connection and no line.

Over it run the embedding provider and, per vault root, one vault client ([ADR-0021](../adr/0021-vault-client.md)):

- **`DaemonEmbeddingProvider`** (`src/modules/semantic/daemon-embedding-provider.ts`) implements `EmbeddingProvider`. `createEmbeddingProvider` builds it for `shared: true` ([`embedding-pipeline.md`](./embedding-pipeline.md#where-the-model-lives)). It is per profile and process-wide, with no vault key and no attach, so it is not a vault client; it runs its own `embed.initialize` handshake per connection epoch, on the same epoch gate the vault attach uses (`createEpochGate`, [`semantic-backend.md`](./semantic-backend.md#the-vault-clients)), so a handshake answered after a reconnect records no batch size.
- **The daemon vault client** (`createDaemonVaultClient`, `src/modules/semantic/vault-client/daemon-client.ts`) is a vault root's `IVaultClient` on the daemon side: `call(method, params)` over the rows of `VaultMethods` (`src/daemon/protocol.ts`), `status(profile)`, `warm()` and `dispose()`. It owns, for both of the vault's views, the one consult of the switch, the attach per connection epoch (`vault.attach`, then `vault.status`), the per-method timeouts and the `NOT_ATTACHED` forget; it is described in [`semantic-backend.md`](./semantic-backend.md#the-vault-client). Once the switch goes `local` it hands every call to the vault's in-process client, the same core over a loopback that calls this daemon's own `vault`, `corpus`, `lexical` and `graph` handlers in the session ([`semantic-backend.md`](./semantic-backend.md#the-in-process-side)).
- **Views over the client** implement the interfaces the session's code depends on. The semantic backend is `createSemanticBackendView` (`src/modules/semantic/backend/view.ts`), over `corpus.*`. The lexical reader is `createLexicalReaderView` (`src/modules/semantic/lexical/view.ts`), over `lexical.search`; it is described in [`lexical-search.md`](./lexical-search.md#who-holds-the-cache). Both are views over the vault's one client ([`semantic-backend.md`](./semantic-backend.md#the-vault-clients)), so a vault makes one `vault.attach` per connection whichever view calls first. Neither flips the switch: only `ensure()` does.

**The embedding contract is the in-process one.** `identity` is computed locally from the profile, so it equals `EmbeddingService`'s and a corpus built through either is served by the other. `maxBatchSize` starts at the in-process value (8) and becomes the daemon's `max_batch_size` once `embed.initialize` answers. A document batch larger than that is split before it is sent. The process keeps its own `createQueuedEmbedder` in front of the facade, so its own queries still go ahead of its own document batches, and it has one request in flight at a time.

**Finding the daemon** (`ISharedServices.ensure()`, run before every call of the embedding provider and of every vault client; concurrent callers share one attempt):

1. POSIX: `ensurePrivateSocketDir` on `/tmp/neuro-vault-<uid>` (see [Paths and files](#paths-and-files)).
2. `connect` to the key's socket, bounded at 2 s. A connection that succeeds is used. `ENOENT` or `ECONNREFUSED` means nothing listens, so go to step 3. Any other error, or a connect that does not settle in time, is ambiguous, as it is for the daemon's own probe: the facade does not spawn on an ambiguous answer, it treats the daemon as unavailable.
3. Spawn the daemon:
   - refuse when the CLI path ends in `.ts`, `.mts` or `.cts` (a development run under a TypeScript runner cannot start `node <file> daemon`);
   - refuse when `cli.js` no longer has the size, mtime and inode this session started with (the inode catches a replacement that kept size and mtime, as npm's fixed extraction mtime allows). An upgrade or rebuild replaced it, and a daemon spawned from it would key itself by the new build and listen on another socket than the one this session polls. The new build's daemon belongs to new sessions;
   - create the state directory (`0700`) and open `daemon.log` for appending;
   - run `spawn(process.execPath, [cliPath, 'daemon'], { detached: true, stdio: ['ignore', log, log], windowsHide: true, cwd: os.homedir() })`, then `unref` the child and close the fd. The daemon outlives the session that started it, so it does not keep that session's project directory as its working directory. An asynchronous spawn `error` is caught and ends the wait early.
4. Poll `connect` every 50 ms for up to 10 s. Two sessions that spawn at once need no coordination: the second daemon loses at the lock or the live-socket probe and exits into the log, and both sessions connect to the winner. A started daemon that exits while nothing listens is spawned again, at most twice (`MAX_RESPAWNS`) within the same budget. The usual cause is a daemon that is still stopping: it unlinks its socket at once but releases its lock only once its connections close, so a daemon spawned in that window exits "already running", and a later spawn finds the lock gone.

**On every new connection**, the embedding provider and each vault client redo their own setup before their first call on it. The embedding facade sends `embed.initialize`, which makes the connection a daemon client at once (holding off the idle exit), loads the profile, and refreshes the batch size. Each vault's client (shared by its backend and its lexical reader) sends `vault.attach` for its vault. `DaemonConnection.epoch` changes with each connection, which is how each knows to do it again after a reconnect: both run their setup on an epoch gate (`createEpochGate`). `DaemonConnection.request()` never connects by itself, so a reconnect cannot skip this step.

**Requests** carry numeric ids and their own timeouts:

| Method | Timeout |
| --- | --- |
| `embed.initialize` | 15 min (the first load downloads the weights) |
| `embed.query` | 60 s |
| `embed.documents` | 5 min |
| `vault.attach`, `vault.status` | 10 s |
| `corpus.nearest`, `corpus.nearestBlocks` | 30 s |
| `lexical.search` | 30 s |

A request that runs out rejects with `DaemonTimeoutError`, naming the method. The connection stays up, since a slow daemon is not a dead one.

**A connection that goes away** (the daemon ends the socket on stop, the socket errors, or a line is not valid JSON-RPC) rejects every pending request with `DaemonConnectionError`, carrying the cause. A request written after the daemon ended its side gets no `SHUTTING_DOWN` answer, so the end of input already counts as the close: nothing waits on a socket that will never answer. The next call runs `ensure()` again and respawns the daemon if it is gone, which is how a session recovers from `daemon stop`, an idle exit after the connection dropped, or a crash. The socket is `unref`'d while nothing is pending, so an idle connection never keeps a finished `index` run or a hung-up stdio server alive. It is `ref`'d while an answer is awaited. A server whose client hangs up closes the shared services in its disposer (`ISharedServices.close()`), which drops the connection, and with it every vault attachment, and rejects a pending request (a cold `embed.initialize` can take minutes) rather than letting it hold the process open. That close is final: a later `ensure()` rejects with `SharedServicesClosedError`, and a connect still in flight stops where it is: its poll timers are cleared (so a cold start cannot hold the process open for the 10 s poll), nothing is spawned or respawned after it, and a socket that connects after it is destroyed. The connection's pending `ensure()` rejects with `DaemonConnectionError`, never `DaemonUnavailableError`, and the services' with `SharedServicesClosedError`, so nothing reconnects, attaches or falls back for a session that is gone.

**Fallback, once per process.** A `DaemonUnavailableError` means the daemon could not be located or started. Every case in steps 1–4 above raises one:

- the socket directory is not ours;
- an ambiguous connect;
- a `.ts` entry point;
- a CLI script that changed since the session started (upgraded or rebuilt), or one that is gone;
- a state directory, log or spawn that fails;
- a poll that runs out;
- no CLI script path at all, or one `createSharedServices` could not stat at startup.

On it, `ISharedServices` flips its switch to `local` for the whole process at once and writes one stderr line. From then on the embedding facade embeds through an in-process `EmbeddingService` for the same profile, and each vault's backend and lexical reader run the vault entry in the process ([`semantic-backend.md`](./semantic-backend.md#the-in-process-side)), each built on its first call after the flip:

```
neuro-vault-mcp: shared daemon unavailable (<reason>); running in-process for this session — see <daemon.log>
```

The `— see <daemon.log>` part is left out when the session never identified its build (no CLI path, or one it could not stat), because then there is no key and no log to name.

**After an upgrade**, a session started before it keeps its daemon for as long as that daemon runs. If the daemon goes away (`daemon stop`, a crash), the session does not start it again, because its `cli.js` has changed (a daemon spawned from it would be the new build, on another key), so it falls back in-process on its next call, as above. Restarting such sessions is what moves them to the new daemon.

From then on the process never touches the connection again. Every other failure reaches the caller and the next call goes through the daemon again. That covers `EMBED_FAILED` (the daemon answered, but the model will not load), `SHUTTING_DOWN`, `CORPUS_NOT_READY`, `CORPUS_FAILED` and `LEXICAL_FAILED`, a timeout and a dropped connection. Falling back on those would load a second model, and a second copy of every vault's corpus and lexical cache, into a session whose daemon is merely busy or restarting. Because every vault attaches in the background at startup, the switch is in practice decided before the first tool call. `--no-shared` selects `EmbeddingService` and the in-process vault entries up front and writes nothing.

**The socket path does not depend on the cache directory.** Two sessions of one build with different `XDG_CACHE_HOME` values share one daemon. Its `daemon.json` and log are under the cache directory of the session that spawned it, so only that cache directory's `daemon status` lists it.

## How a new service attaches

A service is one more registry entry. In `startServing` (`src/cli-daemon.ts`), next to `embed`, the daemon registers each entry of the per-vault service map:

```typescript
registry.register('embed', embed.handlers);
for (const [name, handlers] of Object.entries(createVaultEntryServices(entries))) {
  registry.register(name, handlers);
}
```

Each of the service's methods is a `defineMethod({ params, handler })`, its params a closed schema declared in `protocol.ts` ([Protocol](#protocol)): the schema is the method's validation, on the socket and the loopback alike, and its param type. Framing, discovery, the key, the lock and the lifecycle do not move. `vault`, `corpus`, `lexical` and `graph` are the second to fifth services built this way, all over the one `VaultEntries` that `startServing` builds; `lexical` was the member of the vault entry that the earlier services named as the next candidate (the per-vault lexical cache, which cost hundreds of MB per session on large vaults), and `graph` serves the entry's wikilink graph, so a vault directory has one. A service that wants to appear in `daemon.info` extends `DaemonInfoResult.services`, which today names `embed` and `vault` (the lexical cache appears inside each `IVaultInfo`, not as a service of its own).

The session side follows one pattern, the facade: the session keeps the interface its code already depends on, and implements it by forwarding to the daemon, with an in-process fallback. For the model that is `DaemonEmbeddingProvider`. For a vault's corpus and its lexical cache it is a view over the vault's client ([above](#the-session-side-facades)), which brings the switch, the attach, the timeouts and the fallback with it; a new per-vault read follows the same shape (below).

### How a new per-vault read is added

A read of the vault entry costs four pieces (`graph.*` was added exactly this way), and none of them is in the client, its two adapters, the link, the attachment or the timeouts:

1. **The entry's method**, on `IVaultEntry` and `VaultEntries` (`src/lib/vault-entry/`).
2. **A service handler**, `defineMethod({ params, handler })` over a closed params schema, registered once in `createVaultEntryServices` (`src/daemon/services/vault-entry-services.ts`): a new namespace is one line there, a new method one more handler in its service. The daemon registers the map and the in-process loopback calls the same map, so both sides serve the read and answer with the same codes.
3. **A row in `VaultMethods`** (`src/daemon/protocol.ts`): the method name with its params type (`z.infer` of the handler's schema) and result type, which the handler's result and the view's call both type against. A method that needs a wait other than the 30 s default adds an entry to `VAULT_CALL_TIMEOUTS` (`src/modules/semantic/vault-client/timeouts.ts`); nothing else is per method.
4. **A view** over `IVaultClient`: `client.call('<ns>.<method>', params)`, and the mapping of the protocol's codes to its interface's own errors.

`test/semantic/vault-client/new-read.test.ts` holds that claim: a row added by declaration merging, its handler beside `createVaultEntryServices`, and a three-line view reach the entry over a real socket and in-process through the production adapters, and the file typechecks. A view of a new interface still needs a factory in `createVaultClients` and a field on `IRegisteredVault` ([`vault-registry.md`](./vault-registry.md)) for the tools to reach it. `daemon status` needs nothing: in-process clients are not connections, and the daemon's connections are counted as before.

## How a remote embedding provider would fit

Not built; the seam is kept open. `EmbeddingProvider` already has the shape a remote API needs: asynchronous throughout, `identity` reported by the provider, query and document embedding as separate calls (a remote API's `input_type`), and `maxBatchSize` reported by the provider rather than assumed by the caller. `embed.initialize` returns `max_batch_size` for the same reason.

A remote provider would be a profile in the closed registry with its own `identity` (`provider: '<api>'`) and calibrated thresholds, built by `createEmbeddingProvider`. Because the daemon builds its providers through that factory, a remote profile would run inside the daemon: one place for the API key, the rate limit and a response cache, with nothing in the protocol or the session facade changing. Nothing in this daemon assumes the model is local; only `EmbeddingService` does.

## Boundaries

- **Nothing MCP-level lives here.** Every session is still a full stdio MCP server with its own `McpServer`, tools, vault registry and wikilink graph ([`mcp-server-shape.md`](./mcp-server-shape.md)), and it composes the semantic leg, fusion and the existence filter itself over the daemon's corpus reads and lexical searches ([`semantic-backend.md`](./semantic-backend.md), [`retrieval-policy.md`](./retrieval-policy.md)). The daemon never sees a tool call, and no tool contract or `ToolHandlerError` code depends on it.
- **Vault paths only through `vault.attach`, and no secrets.** The daemon is keyed by build, not by vault, and `daemon.json` holds only the fields above. A vault path reaches the daemon only as the `vault.attach` param of a connection that chose to attach it, and the daemon reads that vault's own `.gitignore` and `.neuro-vault/config.json` and writes under its `.neuro-vault/corpus/`, as a session on `--no-shared` does.
- **Nothing network-reachable.** No TCP port, no HTTP, no authentication: access control is the socket file's mode inside a `0700` directory that `ensurePrivateSocketDir` has verified is ours. A network-facing hub is a separate design (#127).
- **No stdout.** The daemon writes its diagnostics to stderr. Only `daemon status` and `daemon stop` print to stdout, and those are reports for a person.
- **Not here:** model loading, tokenisation and pooling ([`embedding-pipeline.md`](./embedding-pipeline.md)); argv parsing and the `kind: 'daemon'` outcome ([`cli-startup.md`](./cli-startup.md)).
