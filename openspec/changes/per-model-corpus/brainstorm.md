# Brainstorm — per-model-corpus (#146)

Raw decision log. Path: **architectural** (on-disk layout change, a revisit of an alternative ADR-0017 rejected, a cross-process invariant, a new CLI flag).

The shape of the change was settled by the owner in chat on 2026-10-14, after the incident below, and is recorded in issue #146. This log does not re-open those decisions; it records them, then the smaller forks this change had to resolve on its own (Q1–Q11). No interactive brainstorming round was run: there was nothing left for one to decide that the owner had not decided.

## Background — the 2026-10-14 incident

Every MCP client session runs its own stdio server process, and each process runs its own watcher and its own reconcile loop over the same `<vault>/.neuro-vault/corpus/`. Nothing coordinates them. On one laptop, over the owner's vault (953 notes):

1. **Different builds fought over one corpus.** Two sessions started on the pre-v17 build (`bge-micro-v2`, 384 dims) and five on v17 (`harrier-270m`, 640 dims). `ensureManifest` discards every shard on an identity mismatch, so every trigger — a note edit, a new session — made the out-of-sync camp wipe all 953 shards and rebuild. The manifest flipped at 16:51, 18:59 and 19:17; one process reached 78 CPU-minutes; the directory ended up with 448 shards of 384 dims beside 443 of 640.
2. **Same-identity processes duplicated and undid each other.** Five v17 sessions, triggered by one edit, each ran the full rebuild at ~2 cores. `clearShards` in one pass deleted shards another pass had just written, and each pass only ever saw the shard listing it took at its own start.
3. **Comparing models is destructive by design** (`eval/README.md`): one corpus directory per vault means `index --model Y` discards X's corpus.

Atomic per-file writes keep a shard from being half-written. They say nothing about N writers doing the same job and erasing each other's output.

Code as it stands (v17.0.0):

- `CorpusStore(vaultRoot, { dims })` roots itself at `<vault>/.neuro-vault/corpus/` (`CORPUS_DIR`), with `manifest.json` and `notes/<sha256(path)[:32]>.json` under it.
- `reconcileCorpus` runs, in order: `ensureManifest` (discard everything on mismatch) → `scan()` → one `listShards()` snapshot → per-note mtime/size/hash compare → orphan sweep → `.gitignore`.
- The server's `createCorpusBackend` serialises passes **within** a process (`currentPass` + `dirty`), reloads its in-memory snapshot only when a pass embedded, renamed or deleted something, and turns a thrown pass into `unavailable` + retry backoff (30 s → 15 min).
- `index` builds one store per vault and reconciles it; `eval` opens the same store read-only and refuses a manifest that does not match the selected profile.
- ADR-0017's Alternatives list "Per-profile corpus directories" as rejected: stale corpora would accumulate unseen, and one profile per process makes switching rare.

## Settled by the owner (not revisited)

1. **One corpus directory per model key**: `<vault>/.neuro-vault/corpus/<model_key>/{manifest.json, notes/}`. The manifest inside still guards the rest of the identity (`embed_version`, `strategy`, `revision`, `dims`, …); a mismatch there rebuilds that directory only — the intended migration path when a profile's revision or the extraction version moves.
2. **The directory name is the model key** — readable — not a hash of the identity.
3. **Migration without a rebuild**: a root-level `manifest.json` + `notes/` is moved (renamed, not copied) into `<model_key from that manifest>/` the first time it is met. Skipped when the target exists. A legacy manifest that does not parse is left alone and a fresh directory is used.
4. **A per-vault reconcile lock**: `corpus/reconcile.lock`, created exclusively, holding the pid. A dead holder (`process.kill(pid, 0)` → `ESRCH`) is replaced; a live holder is waited on with a bounded backoff; the lock is released in `finally`; a pass that waited reads the manifest after acquiring, so a now-compatible corpus gets an incremental pass instead of a rebuild.
5. **`neuro-vault-mcp index --prune`** deletes every other model's corpus directory under the vault and reports what it removed — never the selected model's. This is the answer to ADR-0017's accumulation objection.
6. **Docs**: an addendum to ADR-0017 (the rejected alternative is adopted, with the incident as evidence), `docs/architecture/own-corpus.md`, `eval/README.md` (eval is no longer "destructive by design").
7. **Non-goals**: sharing the reconcile or the watcher between processes (a later `watch.*` service of the shared daemon, #145); any change to shard format or identity fields; garbage-collecting other models' corpora automatically.
8. **Independent of #145** (`shared-embedding-daemon`): its embed service never touches the corpus. The two changes overlap only in `config.ts`, `cli-index.ts`, `types.ts` and `docs/adr/INDEX.md`.

## Decision chain (forks this change resolved)

### Q1. How does the store learn which directory is its own?

`CorpusStore` already requires `dims`, taken from the provider identity. The model key comes from the same identity. **Decision:** `CorpusStoreDeps` gains a required `modelKey`; the store roots itself at `modelCorpusDir(vaultRoot, modelKey)`. Required, not defaulted — a store that silently fell back to the root would recreate the shared directory. The type change lands with every call site (`cli-index.ts`, `modules/semantic/backend/index.ts`, `eval/backends.ts`, and the tests), because the typecheck gate cannot be satisfied across a split.

Path helpers move into a small `layout.ts`: `CORPUS_DIR`, `corpusRootOf(vaultRoot)`, `modelCorpusDir(vaultRoot, modelKey)`, `isModelDirName(name)`. `shard-store.ts` imports from it; nothing imports the other way, so the migration and prune modules can depend on `layout.ts` without a cycle.

### Q2. What is a valid directory name?

The registry's keys (`harrier-270m`, `granite-97m`, `harrier-0.6b`) are all safe path segments, but a legacy manifest's `model_key` is data read off disk. **Decision:** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, and never `notes` (the legacy shard directory at the corpus root). The leading-character rule excludes `.`, `..` and dotfiles. `modelCorpusDir` throws on anything else — for a registry key that is a programming error. A legacy manifest whose `model_key` fails the rule counts as "does not parse" for migration (settled point 3).

### Q3. When is a legacy corpus "migrated", and what if the rename is interrupted?

Two renames (`notes/`, then `manifest.json`) are not atomic as a pair. **Decision:** key everything on the target's manifest:

- No root `manifest.json` → nothing to migrate.
- Root manifest does not parse, or its `model_key` fails Q2 → left in place, no warning per pass (it would repeat on every debounced tick); `--prune` removes it.
- `<key>/manifest.json` exists → "the target exists"; the legacy entries are left in place (stale; `--prune` removes them).
- Otherwise: `mkdir <key>/`; rename `notes/` → `<key>/notes/` **unless `<key>/notes/` already exists**; then rename `manifest.json` → `<key>/manifest.json`. One stderr line names the move.

The manifest moves last, so a crash between the two renames leaves the root manifest in place and the target without one; the next attempt sees "target has no manifest", skips the notes rename (already there) and finishes. A rename whose source is gone (`ENOENT`) means another process got there first and is not an error.

### Q4. Who runs the migration?

Candidates: the store constructor (synchronous — cannot), the backend's startup selection, `eval`, `index`, every reconcile pass. **Decision:** inside the reconcile pass, **under the lock**, before `ensureManifest`. Every server and every `index` run goes through a pass, so every vault migrates on its first pass after the upgrade, and the lock means two processes never race the renames.

Consequences, accepted:

- The backend's startup selection reads only `<key>/`. On the first start after the upgrade it finds nothing, reports `indexing`, and the first pass migrates and then runs incrementally — every note `reused`, nothing embedded — and loads the snapshot (the backend always loads when nothing was ever decoded). The cost is one stat pass before semantic results return, not a rebuild.
- `eval` stays read-only: it neither migrates nor takes the lock. Run before any server or `index` touched the vault on the new build, it reports the model's corpus missing and names the `index` command — which migrates without embedding.

### Q5. The lock's bound, and what a timeout does

Settled: bounded wait on a live holder. Realistic waits: an incremental pass is seconds; a cold index of the default profile on ~950 notes took 7.9–8.8 min; of `harrier-0.6b`, 35.5 min.

**Decision:**

- Poll with a backoff starting at 50 ms, doubling, capped at 2 s; give up after **10 minutes** in total (`LOCK_MAX_WAIT_MS`). One stat-and-read per poll is negligible.
- A timeout throws `CorpusLockTimeoutError`, naming the lock file, the holder's pid and the wait.
- The **server** treats a timeout as "still contended", not as a failure: the vault keeps its status and its snapshot (a `ready` vault stays `ready`), one stderr line names the holder and the lock file, and the backend re-arms itself through its existing retry backoff. So a server never gives up on its own corpus, and the bound only decides how often it says so.
- **`index`** fails that vault (stderr, non-zero exit) after 10 minutes. A user who started `index` while a server cold-indexes a large profile can re-run it.
- The wait is abortable: the pass's `AbortSignal` (server shutdown, design D10 of the backend) cancels the sleep, and the aborted pass returns the empty summary exactly as an abort before any I/O does today.

### Q6. Which locks are stale?

Settled: a dead pid is replaced. Three more cases need a rule:

- **The lock names this process's own pid.** Within one process, passes over one vault never overlap: the backend serialises them, `index` and `eval` are sequential, and two `--vault` entries cannot name one directory (basename uniqueness). So a lock carrying our pid that we did not just create is a leftover from a dead process whose pid we inherited. **Stale.**
- **The lock's content does not parse.** `writeFile(…, { flag: 'wx' })` creates the file and then writes ~60 bytes, so a reader can catch it empty. **Decision:** unparseable content is treated as a live holder with an unknown pid for up to 1 s from the moment this waiter first saw it; still unparseable after that, it is stale.
- **`kill(pid, 0)` → `EPERM`.** The process exists under another user. **Live.**

Replacing a stale lock: re-read it, and unlink only if the content is still exactly what was judged stale, then retry the exclusive create. Two waiters judging the same dead lock at the same instant can still both get through once; the consequence is one pair of overlapping passes — today's behaviour, self-correcting on the next pass. Documented as a risk, not engineered away (a `link(2)`-based create or an fcntl lock was weighed and rejected: the first fails on filesystems without hard links, which vaults on synced or removable drives can be on; the second has no portable Node API).

**Pid reuse by an unrelated live process** (the holder died and another program took its pid) looks live and stalls every pass for the bound. The server's per-timeout stderr line names the lock file, so the owner can delete it; documented.

### Q7. Is the lock per model or per vault?

Settled: per vault (`corpus/reconcile.lock`, beside the model directories). Two servers on different models therefore serialise their passes too. That is accepted, and wanted: two concurrent cold indexes of one vault were half the CPU picture of the incident, and the lock costs a waiting process nothing but time — each still serves its own snapshot meanwhile.

### Q8. A pass that waited, then reused everything — is the server's snapshot stale?

Yes, and the lock makes it routine. Server A and server B both see an edit to note X. A takes the lock and re-embeds X. B waits, then runs: X's shard now matches the disk, so B counts it `reused`, embeds nothing, and — under today's rule ("reload only when this pass changed something") — keeps serving X's old vectors until X changes again. (Without the lock the same staleness already happens whenever A's pass finishes before B's starts; the lock turns an occasional race into the common case.)

**Decision:** `ReconcileOptions` gains `onLockWait({ holderPid })`, fired once when a pass finds the lock held by a live process. The backend records it for the pass and reloads its snapshot after a pass that waited, whatever the counts say. A pass that never waited keeps today's rule. Reloading costs one decode (~68 ms at 2 500 shards). The broader case — another process changed the corpus entirely between two of this process's passes — stays as it is today (not made worse, and outside this change's scope).

### Q9. What exactly does `--prune` remove, and when?

**Decision:**

- After the vault's reconcile returns (with or without failed notes). Skipped when the reconcile threw: a vault whose selected model could not be built at all (offline first run, say) must not lose the corpus it could still be served from.
- Under the vault's lock, so it never deletes a directory mid-pass of another process.
- Removes every **directory** under `corpus/` except `<selected_key>/` — other models' directories and the legacy root `notes/` — and a legacy root `manifest.json`. Leaves `reconcile.lock` and any other file alone.
- Reports one stdout line per vault: `pruned <vault>: removed <entries>` (sorted), or `pruned <vault>: nothing to remove`.

A live server of a pruned model loses its corpus on disk; its next pass finds no manifest, rebuilds, and its in-memory snapshot serves meanwhile. Documented; `--prune` is explicit, which is the point of settled point 5.

### Q10. What does eval say when the selected model has no corpus but others exist?

Today "built by another profile" is a manifest mismatch. Under per-model directories, selecting `harrier-270m` on a vault indexed only with `granite-97m` finds no `harrier-270m/` at all. **Decision:** the "missing or empty" error also lists the model corpora that do exist under the vault (`listModelCorpora`), so the user sees why, and the manifest-vs-profile gate remains for a model directory whose identity moved (revision, `embed_version`, …).

### Q11. Which specs change?

`own-corpus-index` (layout and manifest requirements MODIFIED; lock and migration ADDED), `cli-index-command` (the on-demand requirement and the rebuild announcement MODIFIED — switching profiles no longer announces a rebuild; `--prune` ADDED), `retrieval-eval` (the pipeline-axis and corpus-loading requirements MODIFIED). One more than the brief named: **`semantic-backend-lifecycle`** gets an ADDED requirement for Q5's timeout behaviour and Q8's reload, because both are observable server behaviour.

## Rejected along the way

- **Directory per identity hash** (settled against): unreadable on disk and in `--prune` output, and a revision bump would orphan a directory instead of rebuilding it in place.
- **Copy instead of rename for migration** (settled against): doubles disk for no reader.
- **Migrating in the backend's startup selection** (Q4): it runs outside the lock, beside the backend's own first pass; two processes would race the renames.
- **Unbounded wait**: a stale lock from a reused pid would hang passes silently forever; the bound turns it into a stderr line every 10 minutes.
- **Reloading after every pass** (Q8): a full decode on every debounced tick, to fix a case only a waited pass makes common.
