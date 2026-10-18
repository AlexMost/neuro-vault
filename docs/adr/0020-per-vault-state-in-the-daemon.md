# ADR-0020 — Per-vault state lives in the daemon's vault entry

- **Status**: Accepted
- **Date**: 2026-10-18

## Context

[ADR-0014](0014-background-corpus-freshness.md) gave every vault of every server session its own in-process chokidar watcher and its own reconcile loop, and the session held that vault's whole decoded corpus in memory. [ADR-0018](0018-shared-services-daemon.md) moved the embedding model into one shared daemon per installed build and named what stayed duplicated: N watchers, N reconcile loops and N lexical caches. [ADR-0019](0019-embedding-storage-interface.md) then made the corpus an interface inside the daemon, owned by a *vault entry* per vault realpath, with sessions reading it and never its vectors. It left open how the entry lives: who creates it, what keeps it alive, when it goes, and how a session reaches it or does without it.

The cost is measured. On the baseline of #158 (build 17.1.1, a ~955-note vault, `harrier-270m`), each extra semantic session settles at about 156 MB footprint against about 63 MB at the `--no-semantic` floor, so about 93 MB per session is per-vault semantic state that can be held once. Several sessions on one vault also run several watchers and reconcile loops over one directory, serialised only by the cross-process `reconcile.lock`.

Two constraints carry over. ADR-0018: a shared capability is a namespaced service plus a session-side facade over an interface the session already depends on, with an in-process fallback, and no new protocol, process or port. ADR-0019: one corpus per (vault realpath, profile), status owned by the vault entry, the scope folded into reads by the entry, and the semantic-leg composition kept in the session.

## Decision

Hold every vault's semantic state once, in the shared daemon, as a **vault entry**, and make the session a client of it.

- **The vault entry.** One per vault directory, keyed by its realpath: the vault's scope, one watcher, one reconcile loop and one corpus per attached model profile. The loop takes the vault's reconcile lock once per pass, scans once, and reconciles every attached profile in attach order. The daemon reads the scope and the `"semantic"` key from the vault's own `.gitignore` and `.neuro-vault/config.json` on every attach; a client never sends them. The module is `src/lib/vault-entry/` (`IVaultEntry`, and `VaultEntries`, the registry `realpath → IVaultEntry`), served by the daemon's `vault` and `corpus` services.
- **Attach, without detach.** `vault.attach { vault, profiles }` makes the connection a client of the entry and of each profile it names. It is additive and idempotent per connection, and answers each profile's status without waiting for a load or a pass. Every later call carries the realpath key it returned. A closed connection is the only detach: there is no `vault.detach`. A facade re-attaches once per connection epoch, before its first call on a new connection.
- **Idle per entry and per corpus.** An entry and each (entry, profile) corpus keep their own set of clients. When a set empties, a timer of the daemon's `--idle-timeout` starts (`0` = never), and an attach before it fires cancels it. An idle corpus leaves the loop and frees its vectors; an idle entry stops its watcher and loop and is dropped. There is no cap and no eviction, and no new flag.
- **One connection and one switch per process.** `ISharedServices` (`src/modules/semantic/shared-services.ts`) owns the process's one `DaemonConnection` and its one one-way switch. Every daemon facade, the embedding provider and the corpus reads alike, runs `ensure()` through it. The switch flips to in-process only when the daemon cannot be located or started (`DaemonUnavailableError`), for every facade at once, with one stderr line. A dropped connection or a timeout fails the call that hit it, and the next call reconnects, respawning the daemon if it is gone. A daemon that dies is retried, never replaced in-process.
- **The fallback runs the same module.** `--no-shared`, and a switch that flipped, serve every vault from one `VaultEntries` built inside the process, on first use. The in-process entries never idle out: the session holds them for its whole life and disposes them when its transport closes.
- **The session holds no vectors, no watcher and no reconcile loop.** A vault's semantic backend in the session is a facade: the corpus's two reads, an asynchronous `status()` and `dispose()`. Under the daemon it forwards to `vault.status` and `corpus.*`; under the fallback, to the in-process entry. At startup the session attaches every semantically enabled vault in the background, so in practice the switch is decided before the first tool call.
- **Supersession.** This supersedes ADR-0014 in part: its in-process watcher, one per vault per session, and the session's disposal of it on transport close. A session that is served by the daemon now only closes its connection, which detaches it; one on the fallback disposes its in-process entries. The rest of ADR-0014 stands: the 10 s debounce, one whole-vault reconcile definition of "changed", `chokidar` as a runtime dependency, a failed watcher degrading rather than failing (now to the pass every attach queues), and the Smart Connections removal.

## Consequences

- **One watcher, one reconcile loop and one decoded corpus per profile per vault directory**, per daemon, whatever the number of sessions. A second `--model` adds a corpus to the same entry, not a second loop.
- **The daemon is now a single point of failure for semantic search.** A daemon crash takes the semantic leg down in every session at once. Each session reconnects on its next call, respawning the daemon, and re-attaches; the entry warm-loads from the shards; the lexical leg never depended on it. `--no-shared` remains per client.
- **A vault's corpus warnings move to the daemon's log.** The rebuild announcement, a corpus that went `unavailable` and the lock-timeout line are written by the entry, so under the daemon they land in `daemon.log`, not on the session's stderr. `daemon status` lists each entry, its clients and each profile's state, and is the operator's only view of the shared state.
- **A short gap keeps the corpus warm.** A session that leaves and returns within the idle timeout finds its corpus loaded and nothing reloads. A profile no session uses any more is freed on its own timer, without waiting for the whole vault to go quiet.
- **Scope changes take effect at the next attach.** Nothing watches `.gitignore` or `config.json`. An attach whose scope differs restarts the entry's watcher, rescopes reads at once and queues a pass. Sessions already attached keep the scope they read at their own startup for their own lexical and graph surfaces until they restart.
- **An upgraded session can fall back mid-life.** A session whose build was replaced cannot spawn its own daemon again, so if that daemon goes away it flips to in-process for the model and for every vault, as ADR-0018 already accepted for the model. Upgrade overlap stays bounded as ADR-0018 says: an old and a new daemon each run an entry for the same directory until the old sessions end, and the lock serialises their passes.
- **The fallback cannot drift from the daemon.** Both run `src/lib/vault-entry/`. There is no second in-session implementation of the reconcile state machine to keep in step.
- **What remains duplicated per session** is the lexical cache and the wikilink graph. They are the next changes (#176, #172), each a vault-entry member reached through the same attach.
- **Constraint on what follows.** Per-vault state that can be shared belongs to the vault entry, reached through an attach on the process's one connection. It does not get its own connection, its own fallback switch or its own detach call.

## Alternatives considered

- **An explicit `vault.detach`**: a crashed session would pin its entries, and a client has a call it can forget. The connection's close already says the session is gone.
- **The session sends its scope with the attach**: sessions on one directory could disagree, and the realpath would no longer identify the state.
- **Drop an entry when its last client leaves**: every session restart would re-decode the corpus and re-run the startup pass. The idle timer costs one timeout of memory.
- **One switch per facade**: embedding in-process while the corpus stays in the daemon, or the reverse, holds two models or two corpora in the worst case.
- **Never switch after startup**: an install upgraded under an open session would lose semantic search until restart.
- **Replace a dropped daemon in-process**: a session whose daemon is merely restarting would load a second model and a second corpus of every vault.
- **Keep the session's own backend for the fallback**: two implementations of one state machine, which the daemon's would outgrow.
- **One loop per (vault, profile)**: two profiles of one vault would take the lock twice per pass and could overlap within the process, which the lock's same-pid rule reads as a dead predecessor.
