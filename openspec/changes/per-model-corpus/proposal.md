Tracked by: #146

## Why

Every MCP session runs its own reconcile over one shared `<vault>/.neuro-vault/corpus/`, uncoordinated. On 2026-10-14, sessions on two builds (bge-micro-v2 and harrier-270m) wiped and rebuilt all 953 shards of the owner's vault against each other on every trigger — one process burned 78 CPU-minutes and shards of 384 and 640 dims ended up side by side — while five same-model sessions duplicated each rebuild and deleted each other's fresh shards. A corpus keyed to one model per vault also makes comparing models destructive by design. Per-model directories stop builds of different models from ever seeing each other's manifest; a per-vault lock stops same-model passes from racing; `--prune` answers the stale-corpus objection that made ADR-0017 reject per-profile directories.

## What Changes

**Corpus layout**
- From: one corpus per vault, `<vault>/.neuro-vault/corpus/{manifest.json, notes/}`; a manifest mismatch of any kind — including another `--model` — discards every shard.
- To: one corpus per vault per model, `<vault>/.neuro-vault/corpus/<model_key>/{manifest.json, notes/}`; the manifest inside still guards the rest of the identity, and a mismatch there rebuilds that directory only. The `.gitignore` entry stays `.neuro-vault/corpus/`.
- Reason: processes of different models never touch each other's corpus; switching `--model` back and forth stops costing a rebuild.
- Impact: non-breaking. An existing root-level corpus is migrated in place on its first pass (rename, no re-embedding). A build from before this change, still running, keeps using the root layout and rebuilds there once.

**Cross-process reconcile lock**
- From: N processes over one vault each run full passes concurrently.
- To: `corpus/reconcile.lock` (host, pid, exclusive create) serialises passes per vault across processes; a dead holder on this host is replaced, a live one — or any holder on another host — waited on for at most 30 minutes; a pass that waited reads the corpus afresh, so it reuses what the holder built.
- Impact: non-breaking; a waiting server keeps serving its snapshot, and reloads it after a pass that waited.

**`neuro-vault-mcp index --prune`**
- New flag: after a vault's reconcile indexed at least one note, deletes every other model's corpus directory (and a leftover legacy root corpus) under the lock and reports what it removed. Never the selected model's.

**Eval**
- No longer destructive by design: `index --model X` → `eval --model X` → `index --model Y` keeps both corpora. Eval reads the selected model's directory, keeps its manifest-vs-profile gate, and names the corpora that do exist when the selected one is missing.

**Docs**
- Addendum to ADR-0017 (the rejected per-profile-directories alternative is adopted, with the incident as evidence); `docs/architecture/own-corpus.md`, `eval/README.md`, and every guide page that says switching `--model` rebuilds the corpus.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `own-corpus-index`: the corpus lives under a per-model directory; a manifest mismatch rebuilds only that directory; ADDED a cross-process reconcile lock and the legacy-layout migration.
- `cli-index-command`: cold index and rebuild announcement restated for per-model directories (switching profiles is no longer a rebuild); ADDED `--prune`.
- `retrieval-eval`: corpus loading reads the selected model's directory and no longer implies one corpus per vault.
- `semantic-backend-lifecycle`: ADDED how a backend behaves when another process holds the vault's lock (reload after a waited pass; a lock timeout neither takes a vault off the air nor gives up).

## Impact

- **Code**: `src/lib/obsidian/corpus/` — new `layout.ts`, `legacy-migration.ts`, `reconcile-lock.ts`, `prune.ts`; `shard-store.ts` (`CorpusStore` requires `modelKey`), `reconcile.ts` (lock + migration + `onLockWait`), `identity.ts` (manifest validator moves here). `src/modules/semantic/backend/{index,corpus-backend}.ts`, `src/cli-index.ts`, `src/config.ts` (`--prune`, `IndexCliOptions.prune`), `eval/backends.ts`.
- **On disk**: `<vault>/.neuro-vault/corpus/` gains `<model_key>/` directories and `reconcile.lock`; nothing outside it changes.
- **CLI**: one new `index` flag; no change to the server invocation.
- **Dependencies**: none.
- **Overlap with #145** (`shared-embedding-daemon`): `config.ts`, `cli-index.ts`, `docs/adr/INDEX.md` — textual merge only, whichever lands second.
