# The Vault Entry

The shared state of one vault directory — its scope, its watcher, its reconcile loop and one corpus per attached model profile — held once per directory by whatever process runs `VaultEntries`, and shared by every client attached to it. The decisions behind it are [ADR-0018](../adr/0018-shared-services-daemon.md) (the daemon it lives in) and [ADR-0019](../adr/0019-embedding-storage-interface.md) (the corpus interface it serves). The code is `src/lib/vault-entry/`; the daemon's wire face is the `vault` service ([`shared-daemon.md`](./shared-daemon.md#the-vault-service)).

**Status of the code.** Built and served by the daemon, but **dark**: no session attaches yet. A session still builds its own per-vault backend, with its own watcher, reconcile loop and in-memory snapshot, exactly as [`semantic-backend.md`](./semantic-backend.md) describes. The change that switches sessions over to attach (and removes that per-session machinery) is the second half of `daemon-vault-registry`; until it lands, no session sends `vault.attach`, so an entry exists only if a client attaches by hand, and nothing reads from it.

## What it is

Two types, both exported from `src/lib/vault-entry/index.ts`:

- **`VaultEntry`** (`vault-entry.ts`) is one vault directory. It holds the vault's `VaultScope`, one watcher, one reconcile loop, and for each attached profile a `ShardCorpus` over a `ShardStore` ([`own-corpus.md`](./own-corpus.md#the-corpus-interface)), plus the profile's status. It knows nothing of connections.
- **`VaultEntries`** (`vault-entries.ts`) is the registry `realpath → VaultEntry`. It owns attach, status, detach, the idle policy and `info()`. A connection is just a numeric id to it.

The module lives under `src/lib/` rather than `src/daemon/` because, once sessions attach (the second half of `daemon-vault-registry`), a session's in-process fallback will construct the same `VaultEntries`. [ADR-0018](../adr/0018-shared-services-daemon.md) requires every shared capability to come with an in-process fallback; serving that fallback from the same module is this change's own requirement, not the ADR's. It imports nothing from `src/modules/`; the document embedder arrives as a port, `embedderFor(profileKey): EmbedDocumentsFn`, which the daemon wires to the `embed` service's queue for that profile (`embed.documentsFor`).

**Not the session's `IVaultEntry`.** `IVaultEntry` (`src/lib/vault-registry.ts`, [`vault-registry.md`](./vault-registry.md)) is the per-session record of one *registered vault*: its reader, provider, wikilink graph and, today, its semantic backend. `VaultEntry` is the shared state of one vault *directory*. Two sessions each hold an `IVaultEntry` for the same directory; they would, once attached, share one `VaultEntry`. The names are kept apart on purpose, and tool code never imports `src/lib/vault-entry/`.

## Attach, and no detach

`VaultEntries.attach(connectionId, vault, profiles)` is additive and idempotent per connection. In order:

1. **The path.** It must be absolute, resolve with `realpath`, and name a directory; anything else is `VAULT_UNAVAILABLE` with the reason. The realpath is the entry's key, so two paths to one directory share one entry, and it is what the answer returns as `vault`.
2. **The profiles.** Every key must be in the closed registry (`MODEL_PROFILES`), else `UNKNOWN_PROFILE`. This runs after the path check, so an unreachable path is reported even with a bad profile.
3. **The scope and the `semantic` key**, re-read from the vault's own files (`loadVaultConfig`, `loadVaultScope`: the root `.gitignore` and `.neuro-vault/config.json`) on *every* attach; the latest attach decides. Nothing watches those two files. When the scope's `ignorePatterns` differ from the entry's, `setScope` restarts the watcher, rescopes the entry's reader and every later read, recomputes the excluded-path set (below) and queues a pass. When the vault's `"semantic"` key flipped, `setSemantic` disables every profile (no store, no corpus, nothing under `.neuro-vault/corpus/`) or gives each a fresh corpus. A profile of a vault with `"semantic": false` reports `disabled`.
4. **Joining.** A profile new to the entry is added (`addProfile`: its corpus starts loading and its first pass is queued), and the connection becomes a client of the entry and of each profile it named. Every attach whose connection joins then queues a pass (`VaultEntry.requestPass`); it coalesces with a pass the attach already queued, and one requested while a pass runs is the single follow-up. That pass is how a warm entry catches up on edits its watcher missed. `profiles: []` attaches the vault alone: scope, watcher and a loop with nothing to reconcile, no corpus.

The answer is `{ vault: <realpath>, profiles: { [profile]: BackendStatus } }` and awaits only the path checks and the two small config files. A corpus load or a pass never delays it: a cold profile answers `{ state: 'indexing', indexed: 0, total: 0 }` and builds in the background, a compatible corpus answers `indexing` and becomes `ready` the moment its startup selection has loaded it.

**There is no `vault.detach`.** A connection that closes detaches itself from every entry and profile it attached (`VaultEntries.detach`, hooked on `ConnectionContext.onClose`, [`shared-daemon.md`](./shared-daemon.md#connection-context-and-error-data)). A crashed session therefore cannot pin an entry, and a client has no call it could forget to make. A connection that closes while its attach is still awaiting the config files is not counted a client of what that attach created; the entry idles out as if it had left.

`status(connectionId, vault, profile)` answers the profile's `BackendStatus`, and `NOT_ATTACHED` unless *this connection* attached that pair. The entry, not the corpus, owns the state: the same four states as [`semantic-backend.md`](./semantic-backend.md#the-contract), with `unavailable` carrying a reason.

## Idle: per entry and per corpus

`VaultEntries` keeps a set of connection ids for each entry and for each (entry, profile). When a set empties, a timer of the daemon's `--idle-timeout` (`idleTimeoutMs`; `0` = never) starts; an attach that names the entry or profile before it fires cancels it.

- A **profile's** timer firing removes the profile from the loop and disposes its corpus, which frees its vectors. A reconcile of that profile in flight is aborted: it stops after the note it is on, and the pass moves on to the next profile (`setSemantic(false)` removes every profile the same way). The entry, its watcher and its other profiles stay.
- An **entry's** timer firing disposes the entry — loop aborted and watcher closed together, the pass settled, every corpus freed — and drops it. `daemon.info` stops listing it. An attach of the same realpath that arrives while that dispose runs waits for it before it creates a new entry: the old pass holds the vault's reconcile lock until the note it is on is done, and a second loop of the same process would take that lock as a dead predecessor's ([`own-corpus.md`](./own-corpus.md)). So a vault directory never has two loops in one process.

So a session that leaves and returns within the timeout finds its corpus warm and nothing reloads; a profile one model's session used and nobody uses now is freed without waiting for the whole vault to go quiet. There is no cap on entries or corpora. The daemon's own idle exit (no clients at all, same timeout) is separate and unchanged; it disposes every entry on the way out.

**Holds.** An attach that has passed its path checks *holds* the entry and the profiles it will reuse until it settles. An idle timer that fires during the hold does not drop them: it records that it fired, and runs on release only if no client joined meanwhile. Without this, the await on the config files is a window in which a returning session's own entry could be dropped from under it. Timers are `unref`'d, so an idle timer is never what keeps the process alive.

`VaultEntries.info()` reports `{ vault, clients, idle_since?, profiles[] }` per entry. `idle_since` is the first time the entry went idle and is present only while it has no client; each profile carries its `state`, `indexed`/`total` while indexing, `reason` while `unavailable`, `notes` (notes with a vector) when `ready`, and `last_reconcile` (`at`, `added`, `changed`, `removed`, `ms`) once a pass finished. This is what `daemon.info` and `daemon status` print ([`shared-daemon.md`](./shared-daemon.md#reporting-vault-state)).

## One reconcile loop, one lock acquisition per pass

Each entry runs exactly one loop (`createReconcileLoop`, `reconcile-loop.ts`) over all its profiles. It is `createCorpusBackend`'s state machine ([`semantic-backend.md`](./semantic-backend.md)) kept *per profile*, with one pass at a time for the vault:

- A pass takes the vault's reconcile lock **once** (`withReconcileLock`, [`own-corpus.md`](./own-corpus.md#concurrency-the-reconcile-lock)), scans **once** — the scan is the entry's scoped scan, shared by every profile — and then runs `reconcileProfile` for each profile enabled when the pass began, in attach order, before releasing the lock. `ensureCorpusGitignored` runs once per pass, after the last profile. A profile attached mid-pass is built by the next pass; a request during a pass, from a watcher event or an attach, is one follow-up pass however many arrive.
- A pass that **waited** for another holder (a running `neuro-vault-mcp index`, another process) calls `refresh()` on each loaded corpus before reconciling it, because a note the holder re-embedded counts as `reused` here and memory would otherwise keep the old vectors.
- Each profile keeps the backend's rules: a compatible corpus with records is `ready` as soon as its startup selection loaded it; a pass that throws for one profile makes *that* profile `unavailable` and the loop moves on to the next; a lock timeout restores what every profile reported before the pass; a profile retried from `unavailable` reports `indexing` while its pass runs; and `ready` is never reported over an empty corpus that indexing failed to produce (the guard's three clauses, `size() === 0 && total > 0 && failed > 0`, are explained where they sit in `reconcile-loop.ts`).
- Any failure or lock timeout re-arms the loop on the usual backoff (`RETRY_BASE_MS` 30 s doubling to `RETRY_MAX_MS` 15 min), one backoff for the loop, cleared by the next successful pass; a request from a watcher or an attach supersedes a pending retry.
- A loop whose profiles are all `disabled` never takes the lock.

### A deleted vault root is unavailable, not an empty vault

A scan of a missing vault root reads as an empty vault, and a pass over an empty vault sweeps every shard. Two things stop a deleted (or unmounted) vault directory from becoming that:

- Before the lock, each pass `stat`s the vault root; a missing or non-directory root fails the pass, so every profile it had not finished goes `unavailable` with the reason, and the loop retries on its backoff. Other entries are untouched. If the directory comes back, the next pass (a retry, or one an attach queues) reconciles it, and that pass restarts the watcher (`onVaultRestored`): the directory that came back is a new inode, which the old watch never sees.
- Nothing recreates the root. `ensureCorpusDir` (`src/lib/obsidian/corpus/ensure-dir.ts`) creates `.neuro-vault/` non-recursively and only what lies below it recursively, so the lock, the shard store and the legacy-corpus migration fail with `ENOENT` rather than `mkdir -p` a fresh, empty vault around a pass that is already running.

**Accepted limitation.** A mount point left behind as an empty directory after its volume unmounted is indistinguishable from a vault with no notes, so a pass over it sweeps the corpus. The shards are rebuilt by the next pass once the volume is back; only the embedding cost is lost.

## The watcher follows the scope

One chokidar watcher per entry (`watcher.ts`, `startVaultWatcher`), started with the entry and restarted by `setScope` and by the first pass that finds a vanished vault root back. The same predicate is used by the session's own backend today, so the two paths cannot disagree. [`vault-scope.md`](./vault-scope.md#the-watcher-prune-vs-filter) has the rule; in short:

- **Prune** (chokidar's `ignored`) only where the scope proves the whole subtree excluded: `isSubtreeExcluded(rel)` — a dot segment, or a prefix of a `<prefix>/**` pattern. chokidar 4 drops a subtree once `ignored` is true for its directory and its `stats` argument is unreliable, so `Archive/*`, which leaves `Archive/2024/note.md` in scope, is not pruned.
- **Filter** (the event handler) forwards an add, change or unlink only for a path that ends in `.md` and is not `isExcluded`. That is what keeps `Archive/*`'s direct children, `*.canvas.md` and the server's own writes under `.neuro-vault/corpus/` from scheduling a pass.
- Paths are judged **relative to the vault root with `/` separators** (`vaultRelative`, which resolves a root containing a backslash with `path.win32`). A dot segment *above* the root, such as `~/.sync/vault`, never reaches the scope, so the vault is not blinded.
- Events arm a debounce (`DEBOUNCE_MS` 10 s; `VaultEntryOptions.debounceMs` overrides it in tests); `onQuiet` calls the loop's `requestPass`. A watcher that fails to start or errors later warns to stderr and fails no request; the entry then degrades to reconcile-on-attach: edits are picked up by the pass every joining attach queues (and by a retry after a failed pass), not as they happen.

## Reads: the excluded-path fold

`VaultEntry.reader(profile)` returns a `CorpusReader` with the scope folded in, so a caller never sends one and a stale corpus cannot show a note the scope hides. The corpus on disk agrees with the scope only after a pass swept the out-of-scope shards, which leaves a window after every scope change. A caller's `limit` is applied inside the corpus, so a hidden note cannot simply be dropped from the result afterwards — it would leave the list short. The entry therefore:

- removes excluded paths from `allowed` and from `nearestBlocks`' `paths`; and
- adds to `exclude` every corpus path the current scope excludes but no pass has swept yet (`excluded`, recomputed from `entries()` once a profile's startup selection or a pass over it has settled, and on every scope change). A read waits for a recompute in flight, so a new scope applies to the next read; and
- answers `null` for a `{ path }` anchor on a note the scope excludes, as the session's snapshot does (the note is not in it), instead of letting its not-yet-swept vector anchor a search.

## What it deliberately does not do

- **No lexical cache, no wikilink graph, no `corpus.*` methods yet.** The entry holds the semantic side only; the daemon serves `vault.attach` and `vault.status` and nothing that reads a corpus over the wire.
- **No watching of `.gitignore` or `config.json`.** Scope changes take effect on the next attach.
- **No scope from the client.** Attach carries a path and profile keys, never exclusions or an identity: sessions could disagree, and the key would no longer identify the state.
- **No format change.** Shards, manifests, the lock and `index` behave as in [`own-corpus.md`](./own-corpus.md).
