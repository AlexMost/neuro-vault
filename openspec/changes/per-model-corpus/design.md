## Context

The server owns an embedding corpus per vault ([ADR-0013](../../../docs/adr/0013-own-embedding-corpus.md)), kept fresh by an in-process watcher and reconcile loop ([ADR-0014](../../../docs/adr/0014-background-corpus-freshness.md)), and since v17 records the full producing identity in its manifest, with a closed set of model profiles chosen by `--model` ([ADR-0017](../../../docs/adr/0017-embedding-model-profiles.md)).

Every MCP client session runs its own stdio server process. Each process builds its own `CorpusStore` over `<vault>/.neuro-vault/corpus/` and its own reconcile loop, with nothing coordinating them. On 2026-10-14 that produced the incident recorded in `brainstorm.md`: two builds on different models wiped and rebuilt all 953 shards of the owner's vault against each other on every trigger (78 CPU-minutes in one process; 384- and 640-dim shards side by side), and five same-model sessions ran the same full rebuild concurrently, `clearShards` in one deleting what another had just written. ADR-0017 had listed per-profile corpus directories as a rejected alternative, because stale corpora would accumulate unseen and switching models was expected to be rare.

The owner settled the remedy (issue #146; `brainstorm.md` § Settled): one directory per model key, an in-place migration of the existing layout, a per-vault cross-process reconcile lock, an explicit `index --prune`, and an ADR-0017 addendum. This design fills in the forks those decisions left open (`brainstorm.md` Q1–Q11).

Code touched (v17.0.0): `src/lib/obsidian/corpus/{shard-store,reconcile,identity}.ts` and new siblings; `src/modules/semantic/backend/{index,corpus-backend}.ts`; `src/cli-index.ts`; `src/config.ts`; `eval/backends.ts`.

## Goals / Non-Goals

**Goals:**

- Processes serving different models never read, rewrite or discard each other's corpus.
- Passes over one vault never run concurrently across processes; a pass that waited reuses what the holder built instead of rebuilding or re-embedding it.
- An existing corpus moves into the new layout without re-embedding a single note.
- Switching `--model` back and forth, and `index --model X` → `eval --model X` → `index --model Y`, costs no rebuild.
- Other models' corpora are removable on request, with a report of what went.
- A waiting server keeps serving; it neither goes `unavailable` nor gives up because another process holds the lock.

**Non-Goals:**

- Sharing one reconcile or one watcher between processes (a later `watch.*` service of the shared daemon, #145).
- Any change to the shard format, the manifest's fields, or the identity comparison.
- Removing other models' corpora automatically.
- Making `eval` write to the corpus (it stays read-only: no migration, no lock).
- Fixing the pre-existing cross-process staleness where another process's pass finishes entirely between two of this process's passes (D8 covers only the waited case, which the lock makes common).

## Decisions

### D1: The model key names the directory; the store requires it

- **Choice**: `<vault>/.neuro-vault/corpus/<model_key>/{manifest.json, notes/}`. `CorpusStoreDeps` gains a required `modelKey: string`; `CorpusStore` roots itself at `modelCorpusDir(vaultRoot, modelKey)`. A new `src/lib/obsidian/corpus/layout.ts` owns the path vocabulary — `CORPUS_DIR` (moved out of `shard-store.ts`), `corpusRootOf(vaultRoot)`, `modelCorpusDir(vaultRoot, modelKey)`, `isModelDirName(name)` — and imports nothing from the other corpus modules, so every other module can import it without a cycle. Callers pass `identity.model_key`, the same identity that already supplies `dims`.
- **Rationale**: the key is readable on disk and in `--prune` output, and stable across a revision bump, so a moved revision rebuilds its directory in place (the manifest gate, unchanged) instead of orphaning it. Required rather than defaulted, because a store that fell back to the corpus root would recreate the shared directory this change removes.
- **Alternatives considered**: a hash of the full identity as the directory name (settled against: unreadable, and every revision bump leaves a stale directory behind); keeping `CorpusStore(vaultRoot, …)` and deriving the key from a manifest on disk (circular — the manifest is what the key locates).

### D2: Directory names are validated

- **Choice**: `isModelDirName(name)` is `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and the name, lower-cased, is none of the corpus root's reserved entries: `notes`, `manifest.json`, `reconcile.lock` (`RESERVED_ROOT_NAMES`). `modelCorpusDir` throws on a name that fails it. The three registry keys pass.
- **Rationale**: a legacy manifest's `model_key` is data read off disk and becomes a path segment during migration; the leading-character rule excludes `.`, `..` and dot-directories. The reserved names are the root's own entries: a key of `manifest.json` or `reconcile.lock` would make migration stat a path *through* a file (`ENOTDIR`) and fail every pass for good, and `Notes` is the same directory as `notes` on a case-insensitive filesystem (APFS, NTFS defaults). Compared lower-cased for that reason.
- **Alternatives considered**: no validation (a crafted or corrupted manifest could name `../..`); escaping the key (makes the directory unreadable, defeating D1).

### D3: Legacy migration — keyed on the target's manifest, manifest renamed last

- **Choice**: `migrateLegacyCorpus(vaultRoot, deps)` in `legacy-migration.ts`:
  1. No root `manifest.json` → `{ kind: 'none' }`.
  2. Root manifest fails the store's manifest validation (`isStoredManifest`, moved to `identity.ts`), or its `model_key` fails D2 → `{ kind: 'skipped', reason: 'unreadable' }`; nothing moves, nothing is warned (it would repeat every pass). The store then uses a fresh `<model_key>/`.
  3. `<model_key>/manifest.json` exists → `{ kind: 'skipped', reason: 'target-exists' }`; the legacy entries stay for `--prune`.
  4. Otherwise `mkdir <model_key>/`; rename `notes/` → `<model_key>/notes/` unless that already exists (or the source is gone); then rename `manifest.json` → `<model_key>/manifest.json`; warn one line on stderr naming the move. `ENOENT` on a rename's source is "already done", never an error.
- **Rationale**: rename, not copy (settled). The two renames are not atomic as a pair, so the manifest goes last: an interruption leaves the root manifest in place and the target without one, and the next attempt completes it (step 4 skips the `notes/` already moved). Skipping a target that already has a manifest is the settled "skip if the target exists", made precise enough to resume.
- **Alternatives considered**: a staging directory renamed into place (still two renames into the staging directory, so no atomicity gained); a whole-directory rename of `corpus/` into `corpus/<key>/` (cannot rename a directory into its own child).

### D4: Migration runs inside the pass, under the lock

- **Choice**: `reconcileCorpus` calls `migrateLegacy()` after acquiring the lock and before `ensureManifest`. `ReconcileDeps.migrateLegacy?: () => Promise<unknown>` defaults to `migrateLegacyCorpus(vaultRoot, { warn })`. Neither the backend's startup selection nor `eval` migrates.
- **Rationale**: every server and every `index` run goes through a pass, so every vault migrates on its first pass after the upgrade, and the lock means two processes never race the renames. The first start after the upgrade reports `indexing` until that pass — every note `reused`, nothing embedded — finishes and the snapshot loads (the backend always loads when nothing was ever decoded).
- **Alternatives considered**: migrating in the startup selection (outside the lock, racing the backend's own first pass and other processes); migrating in `eval` (would make eval write and wait on the lock).

### D5: The reconcile lock

- **Choice**: `reconcile-lock.ts` exports `acquireCorpusLock(corpusRoot, deps, opts) → Promise<CorpusLock>` with `CorpusLock.release()`, and `CorpusLockTimeoutError`. The file is `<vault>/.neuro-vault/corpus/reconcile.lock`, one per vault, shared by every model.
  - **Create**: `writeFile(lockFile, JSON.stringify({ host, pid, token, acquired }), { flag: 'wx' })`, where `host` is `os.hostname()` and `token` a fresh `randomUUID()`. `EEXIST` means held.
  - **Holder judgement**, on each failed create: read the file. Gone (`ENOENT`) → retry at once the first time in a row; after that, back off on the live-holder schedule under the same bound (a dangling symlink at the lock path reads as gone forever and must not spin). Parses with a positive integer `pid` (a missing `host` reads as this host):
    - `host` differs from ours → live, always: a pid from another machine, or from another container's pid namespace (containers get their own hostname by default), cannot be checked with `kill` here, and judging it dead would take a live lock away;
    - same host and `pid === own pid` → stale (within one process, passes over one vault never overlap: the backend serialises them, `index` and `eval` are sequential, and two `--vault` entries cannot name one directory);
    - same host and `isAlive(pid)` false — `process.kill(pid, 0)` throwing `ESRCH` — → stale;
    - otherwise live (`EPERM` counts as alive).
    Does not parse → live with unknown pid until `LOCK_UNREADABLE_GRACE_MS` (1 s) after this waiter first saw it unparseable, then stale (a `wx` create writes after it creates, so a reader can catch it empty).
  - **Stale replacement**: re-read; unlink only if the content is still exactly what was judged stale; retry the create immediately.
  - **Live holder**: on the first live sighting call `opts.onWait({ holderPid, holderHost })` once; sleep `LOCK_POLL_MIN_MS` (50 ms), doubling to `LOCK_POLL_MAX_MS` (2 s); after `LOCK_MAX_WAIT_MS` (**30 minutes**) of total waiting throw `CorpusLockTimeoutError` naming the lock file, the holder's host and pid, and the wait.
  - **Abort**: the sleep takes the pass's `AbortSignal`; an aborted wait rejects, and `reconcileCorpus` turns an abort during acquisition into the same empty summary it returns for an abort before any I/O.
  - **Release**: in `finally`; unlinks only if the file still holds exactly the content this acquisition wrote (the token makes it unique, so two holders can never remove each other's lock, even within one process); never throws (a failure is warned).
  - **DI**: `CorpusLockDeps { pid, host, token, isAlive, createExclusive, readFile, unlink, mkdir, sleep, now, maxWaitMs, warn }`, all defaulted; tests inject them, no module-level mocks.
- **Rationale**: exclusive create + pid is the settled mechanism; the host makes it honest about what `kill(pid, 0)` can know. The bound: an incremental pass is seconds; a default-profile cold index on ~950 notes measured 7.9–8.8 min, and the holder also keeps the lock while a first run downloads its model (≈ 344 MB for the default). Thirty minutes is about three times the measured cold index, so routine waits — a second session starting while the first cold-indexes — finish inside it; what happens past it differs by caller (D7, D9), and a server never gives up. Treating our own pid as stale avoids a process waiting the full bound on a leftover from a dead process whose pid it inherited.
- **Alternatives considered**: a 10-minute bound (the first draft — only ~10 % above the measured cold index, so a larger vault or a first-run download would time waiters out routinely); `link(2)` onto the lock path for an atomic create-with-content (fails on filesystems without hard links, which a vault on a synced or removable drive can be on); `flock`/`fcntl` (no portable Node API); a heartbeat refreshing the lock's mtime so age could prove staleness (a background timer in every pass, to solve pid reuse, which the bound already makes visible); an unbounded wait (a reused pid would hang every pass silently).

### D6: The pass order

- **Choice**: `reconcileCorpus` becomes: abort check → **acquire lock** (with `onWait` forwarding to `opts.onLockWait`) → **migrate legacy** → `ensureManifest` → `scan` → `listShards` → per-note loop → orphan sweep → `.gitignore` → **release** (finally). `ReconcileDeps.acquireLock?` defaults to `acquireCorpusLock(corpusRootOf(vaultRoot), { warn }, …)`. `ReconcileOptions.onLockWait?: ({ holderPid }) => void`, guarded like `onProgress`.
- **Rationale**: everything that reads the corpus — the manifest, the shard listing — happens after the lock is held, so a pass that waited reads what the previous holder left: a corpus that became compatible gets an incremental pass, and nothing it re-embedded is embedded twice. This is the settled "re-read the manifest after acquiring", by construction rather than as a second read.
- **Alternatives considered**: taking the lock in each caller (the backend and `index`) — two places to forget, and the test harnesses that drive `reconcileCorpus` directly would never exercise it.

### D7: The server under contention

- **Choice**: in `createCorpusBackend`, each pass passes `onLockWait` and records that it waited. After a pass that waited, the backend reloads its snapshot whatever the counts say (today's rule — reload when `embedded + renamed + deleted > 0` or nothing was ever decoded — still governs a pass that did not wait). A pass that throws `CorpusLockTimeoutError` restores the `status` the vault reported before that pass began (a retry pass from `unavailable` first switches to `indexing`; the timeout puts `unavailable`, with its reason, back), leaves `snapshot` untouched, writes one stderr line naming the vault, the holder's host and pid and the lock file, and re-arms through the existing retry backoff (`RETRY_BASE_MS` 30 s → `RETRY_MAX_MS` 15 min). Every other throw keeps today's `unavailable` path.
- **Rationale**: with the lock, "the other server re-embedded the edited note while I waited" is the common case, and under today's rule this server would then reuse it and keep serving the old vectors. A timeout means "someone is still building", not "this vault is broken" — reporting `unavailable` would take a serving vault off the air and tell callers to run a competing `index`.
- **Alternatives considered**: reloading after every pass (a full decode on every debounced tick); retrying immediately after a timeout (a busy loop of 30-minute waits with no backoff).

### D8: `index --prune`

- **Choice**: `--prune` (boolean, default false) on the `index` command only; `IndexCliOptions.prune`. For each vault, after its reconcile returns having indexed something — skipped when it threw, and skipped when it returned with `total > 0` and `embedded + reused + renamed === 0` (every in-scope note failed: `reconcileCorpus` contains embed failures per note and returns normally, so an offline first run of a new profile never throws) — `pruneOtherCorpora(vaultRoot, keepModelKey, deps)` runs **under the vault's lock** and removes every directory directly under `corpus/` except `<keepModelKey>/` (other models' directories and the legacy root `notes/`), plus a legacy root `manifest.json`; it leaves `reconcile.lock` and any other file. Before removing anything it refuses (throws, so that vault fails) when `keepModelKey` is not a valid directory name or `<keepModelKey>/manifest.json` is absent — two concurrent `--prune` runs of different models, each reconciled and then waiting, would otherwise delete each other's corpus and leave the vault with none. It returns the removed names, sorted; `index` prints `pruned <vault>: removed <a>, <b>` or `pruned <vault>: nothing to remove` on stdout. A prune error is that vault's fatal error (stderr, non-zero exit). `listModelCorpora(vaultRoot)` (the model directories present, sorted) lives in the same module for eval's message (D10).
- **Rationale**: explicit and reported (settled). After the reconcile, so the selected model's corpus exists and is current before the others go; skipped when that reconcile threw or indexed nothing, so an offline first run of a new model cannot leave the vault with nothing to serve. A skip writes `not pruning <vault>: <reason>` on stderr. The test for it drives the real failure shape — a reconcile that *returns* with every note failed — not a thrown error. Under the lock, so it never deletes a directory another process is mid-pass in. The legacy root entries are, by D3, either already migrated away or a corpus nothing on this build will ever read.
- **Alternatives considered**: removing only entries whose names are registry keys (would leave a retired model's directory — `bge-micro-v2/` after migration — forever); a separate `prune` subcommand (a second command surface for one flag's work).

### D9: `index` under contention

- **Choice**: `index` passes `onLockWait` and writes `waiting for another neuro-vault process (pid <n>[ on <host>]) to finish with <vault>…` on **stderr** once per lock acquisition that waits — the reconcile's and, with `--prune`, the prune's (the host only when it is not this one; no parenthesis while the holder's pid is unreadable). A `CorpusLockTimeoutError` is that vault's fatal error. `--model`'s help text drops "a vault indexed with another model is rebuilt" and says each model keeps its own corpus.
- **Rationale**: stdout carries progress, rebuild and summary lines (and now prune lines); a wait notice is a diagnostic. Thirty minutes covers any incremental pass and the default profile's cold index of a vault several times the owner's; a user whose `index` collided with a longer one re-runs it.

### D10: Eval reads the selected model's directory

- **Choice**: `eval/backends.ts` builds `CorpusStore(vaultRoot, { modelKey: expected.model_key, dims })`. The manifest-vs-profile gate is unchanged (a model directory whose revision or `embed_version` moved still refuses). The missing-or-empty error names the model's directory and, when other model corpora exist, lists them (`listModelCorpora`). Eval neither migrates nor takes the lock.
- **Rationale**: eval must stay read-only and must not wait behind a server's pass; selecting a model selects its corpus, so comparing models no longer rebuilds anything.

### D11: Docs, including the ADR-0017 addendum

- **Choice**: no new ADR — the owner chose an addendum to ADR-0017, because the decision is the revisit of one of its alternatives. Proposed text, appended under ADR-0017's **Alternatives considered** as a dated note, with the Status line extended to `Accepted; per-profile corpus directories adopted 2026-10-14 (see Revisited)`:

  > **Revisited 2026-10-14 — per-profile corpus directories adopted.** The rejection above assumed one profile per vault at a time. It did not hold: every MCP session runs its own server process, and on 2026-10-14 sessions on the pre-v17 build (`bge-micro-v2`) and on v17 (`harrier-270m`) shared the owner's 953-note vault. Each trigger made the out-of-sync side discard and rebuild every shard; the manifest flipped three times in an afternoon, one process accumulated 78 CPU-minutes, and the directory ended up holding 384- and 640-dimension shards side by side. Five same-model sessions meanwhile ran the same rebuild concurrently and deleted each other's fresh shards. The corpus is now one directory per model key (`<vault>/.neuro-vault/corpus/<model_key>/`), with the manifest inside still gating the rest of the identity; the accumulation concern is answered by `neuro-vault-mcp index --prune`; concurrent passes are serialised by a per-vault `reconcile.lock`. The Operations bullet above about discarding each other's corpus no longer applies. Details: `docs/architecture/own-corpus.md` and the `per-model-corpus` change (#146).

  `docs/adr/INDEX.md`: ADR-0017's status cell gains `; per-profile directories adopted 2026-10-14`.

  Other docs, each a sweep for "rebuild"/"one corpus per vault"/"same `--model`":
  - `docs/architecture/own-corpus.md` — On-disk layout (per-model tree, `reconcile.lock`), a new "Migration from the single-corpus layout" subsection, a new "Concurrency: the reconcile lock" section (bound, staleness rules, D7/D9 behaviour), "A model change is a rebuild" restated as "an identity change within a model is a rebuild", Boundaries (cross-process locking is no longer out of scope; sharing one reconcile still is), `--prune`.
  - `docs/architecture/semantic-backend.md` — reload after a waited pass; a lock timeout keeps state and re-arms.
  - `docs/architecture/cli-startup.md` — the `--model` sentence; `--prune`.
  - `eval/README.md` — "destructive by design" paragraphs (§ corpus, § comparing profiles) rewritten; the A/B workflow.
  - `docs/guide/embedding-models.md` — "keep the server and `index` on the same `--model`" (still advisable, for pre-warming, no longer to avoid mutual rebuilds); the "use a copy" advice for comparisons; `--prune`.
  - `docs/guide/installation.md`, `README.md` — the `index` paragraphs.
- **Rationale**: the decision is a revisit of ADR-0017's alternative, so the record belongs beside the rejection it overturns; a reader of ADR-0017 must not leave believing switching models discards a corpus.

## Risks / Trade-offs

- [Risk] Two waiters judge the same dead lock stale in the same instant; both unlink-and-create, and the second deletes the first's fresh lock → Mitigation: the unlink is conditional on the content being unchanged, which narrows the window to microseconds; the worst case is one pair of overlapping passes — today's behaviour, self-correcting on the next pass. Accepted.
- [Risk] A holder died and an unrelated live process took its pid; the lock looks live and every pass waits the full bound → Mitigation: the server writes a stderr line per timeout naming the lock file and pid; deleting the file clears it. Accepted.
- [Risk] A holder on another host or in another container died; its lock can never be judged stale from here → Mitigation: the same as pid reuse — a stderr line per 30-minute timeout naming the host, pid and file. Taking such a lock over on a guess would reintroduce the concurrent passes the lock exists to prevent. Accepted.
- [Risk] Processes of the **same** model key but different identity (e.g. a future build bumps `embed_version` while an older build still runs) still rebuild each other's directory → Mitigation: the lock serialises them, so they alternate rather than interleave; this is the settled "a mismatch rebuilds that directory only", the migration path when a profile moves. Accepted; the incident's cross-model case cannot recur.
- [Risk] A pre-per-model build still running after the upgrade loses its root corpus to migration, and rebuilds at the root once → Mitigation: it keeps working on its own root files; the new build never reads them again; `--prune` removes them. Documented in the migration plan.
- [Risk] `--prune` removes the directory of a model a live server is serving → Mitigation: under the lock, so never mid-pass; that server's snapshot keeps serving and its next pass rebuilds. Documented; `--prune` is explicit.
- [Risk] The first server start after the upgrade serves no semantic results until its first pass (migration + an incremental stat pass) finishes → Mitigation: lexical search keeps working; the pass embeds nothing. Tests assert the migrated corpus reconciles with zero embeds.
- [Trade-off] One lock per vault, not per model, so servers on different models serialise their passes → accepted: concurrent cold indexes were half of the incident's CPU, and a waiting server keeps serving its own snapshot.
- [Trade-off] Disk: two models' corpora coexist until pruned (the default's corpus is about 20 MB on a ~900-note vault: 640-dim float32 vectors, base64 in the shards) → accepted; that is the cost of a non-destructive switch, and `--prune` is the lever.
- [Risk] The lock or migration could make a test harness that drives `reconcileCorpus` concurrently in one process steal its own lock (same pid) → Mitigation: tests of contention inject distinct `pid`s; the real two-process behaviour is the manual check (plan, last task).
- [Risk] Parallel-safe plan tasks run in one shared worktree would see each other's half-written files in the project-wide typecheck/lint gates, and their commits would collide → Mitigation: `tasks.md` allows parallel dispatch only with one worktree per task; otherwise those tasks run one after another.

## Migration Plan

1. **Ship** as a minor release (no breaking change: layout migrates in place, one new flag).
2. **First pass per vault** on the new build moves `corpus/{manifest.json, notes/}` into `corpus/<model_key>/` under the lock and reconciles incrementally (zero embeds). A legacy `bge-micro-v2` corpus moves into `corpus/bge-micro-v2/` and is never read again by this build; `index --prune` removes it.
3. **Mixed builds during the upgrade window**: sessions still on v17 keep using the root layout; the first of them to run after the migration finds no root manifest and rebuilds at the root once. Restarting those sessions ends it; `index --prune` cleans what they left.
4. **Rollback**: downgrading to v17 sees no root corpus and rebuilds it at the root (one cold index); the per-model directories stay and are reused if the upgrade is re-applied. No data outside `.neuro-vault/corpus/` is touched either way.
5. **Acceptance**: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` pass; the manual two-process check in the plan shows one pass embedding and the other reusing; a legacy layout migrates with `embedded=0`; `--prune` removes exactly the other entries.

## Open Questions

None blocking. Two follow-ups recorded rather than solved here:

- The cross-process staleness that does not involve a wait (another process's pass finishing entirely between two of this process's passes) predates this change; the shared daemon's `watch.*` service (#145's successor) removes it by having one reconciler.
- `SEMANTIC_INDEX_NOT_FOUND`'s hint still omits `--model` (ADR-0017 § Operations); unchanged here.
