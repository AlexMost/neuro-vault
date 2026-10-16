# The Own Corpus

The embedding corpus the server builds and owns: how a note becomes model inputs, where the vectors live, and how the corpus is kept in agreement with the vault. The decision behind it is [ADR-0013](../adr/0013-own-embedding-corpus.md), which supersedes the "the server never writes embeddings" half of [ADR-0006](../adr/0006-smart-connections-corpus.md).

Keeping this corpus fresh once the server is running — the per-vault watcher, its debounce, and who calls `reconcileCorpus` — is not this file's concern. See [`semantic-backend.md`](./semantic-backend.md) and [ADR-0014](../adr/0014-background-corpus-freshness.md); the daemon's shared version of the same loop, one per vault directory over many profiles, is [`vault-entry.md`](./vault-entry.md).

## What it is

The pieces, all under `src/lib/obsidian/corpus/` and deliberately free of any import from `src/modules/` — the indexer sees the embedding model only through a one-function port, `EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>`, called once per note with the note-level text and every block text, vectors back in input order. A failed call fails only that note:

| File | Responsibility |
| --- | --- |
| `chunker.ts` | Splits a note into keyed blocks with line spans. |
| `embed-text.ts` | Turns a note and its blocks into the exact strings sent to the model, and applies the size gate. |
| `layout.ts` | The path vocabulary: the corpus root, one model's directory, the reconcile lock's name, and the rule for a legal directory name. |
| `shard-store.ts` | `ShardStore`: reads, writes, lists and deletes the shards and manifest of one model's directory; atomic writes; `.gitignore` upkeep. |
| `ensure-dir.ts` | `ensureCorpusDir`: creates the directories a write needs without ever recreating the vault root (below). |
| `corpus.ts` | The corpus interface: `ICorpusReader`, `ICorpusWriter`, `ICorpus` (below). |
| `shard-corpus.ts` | `ShardCorpus`, the in-memory `ICorpus` over a `ShardStore`. |
| `shard-writer.ts` | `shardWriter`, a disk-only `ICorpusWriter` over a `ShardStore`. |
| `scoring.ts` | Cosine similarity and the ordering of ranked hits, shared by `ShardCorpus` and `SearchEngine`. |
| `reconcile.ts` | Brings one model's corpus into agreement with the vault: `withReconcileLock` and `reconcileProfile`, composed by `reconcileCorpus`. |
| `reconcile-lock.ts` | The per-vault cross-process lock a pass runs under. |
| `legacy-migration.ts` | Moves a single-corpus layout into its model's directory. |
| `prune.ts` | Lists the models whose corpora exist and removes the others (`index --prune`). |

`types.ts` holds the shapes and the three constants that fix how text becomes vectors: `MIN_CHARS` (200), `EMBED_STRATEGY` (`token-window-v1`: notes and blocks are bounded by the profile's token window, not by a character budget) and `EMBED_VERSION` (2). It holds **no model constants**: which model made the vectors is not the corpus's to know. The embedding provider reports an `EmbeddingIdentity` (`provider`, `model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens` — see [`embedding-pipeline.md`](./embedding-pipeline.md)), and `identity.ts` derives the corpus identity from it: `corpusIdentityOf` takes every field the provider reports and adds `embed_version` and `strategy` from this build's constants — exactly the fields of the manifest below, minus `created` — and `formatIdentity` names an identity (`<model_key> (embed_version <n>)`) in rebuild messages.

## Extraction

### Block keys

A block's key is its heading path within the note; the note path is prepended only when the key is used as a corpus-wide identity. The separator run encodes the child's real level, so a skipped level stays visible in the key.

| Key | What it is |
| --- | --- |
| `#---frontmatter---` | The frontmatter block, span including both `---` fences. |
| `#` | The text before the first heading. |
| `#Top`, `#Top#Inner` | Heading blocks; `#Top###Deep` is an H3 directly under an H1. |
| `#Top#{1}`, `#Top#{2}` | Content chunks — blank-line-separated paragraphs a heading owns directly, minted only when it owns more than one. |
| `#Top[2]` | A repeated heading. The suffix applies at **every** level, not only at the top. |

Block boundaries come from parsing the note as CommonMark (`mdast-util-from-markdown`), not from a line scanner: fence nesting, fences of four or more backticks, indented code and HTML blocks are all beyond a regex, and each one a scanner gets wrong loses content into no block at all. Only root-level ATX headings open a block — headings inside a blockquote or a list item, setext headings, and a `#` with an empty title do not. The title is read from the raw source line, so `# **Bold** title` and `# Title ###` keep the keys they had.

Spans are 1-based and inclusive, and a heading block's span covers its whole section including nested subsections, so parent and child spans overlap.

### The two embed-text formulas

```
block:  breadcrumbs(notePath + blockKey, last heading segment dropped) + "\n" + block text
note:   breadcrumbs(notePath) + ":\n" + full note text
```

Breadcrumbs replace `/` and `#` with ` > ` and drop a trailing `.md`. Both formulas carry the note's path — the fact the whole reconcile design turns on. Neither is cut here: how much of a long text reaches the model is decided in tokens by the active profile's tokenizer (see [The token window](#the-token-window)).

### The size gate

A note or block is embedded only when its text reaches `MIN_CHARS` (200). A heading block whose span is entirely accounted for by kept sub-blocks is dropped, so a pure container heading is not embedded twice; a heading that also holds text of its own stays. Below-gate notes are still members of the vault and still get a shard — they simply carry no note-level vector.

The gate and the token bound are **content** rules: they decide what text of an included note is embedded, never which notes are included. Membership is [vault scope](vault-scope.md) alone.

### Named divergences from the corpus being replaced

Extraction reproduces the replaced corpus 1:1 so that the one diagnostic run comparing the two backends is interpretable. Six divergences are accepted on purpose:

1. `excluded_headings` is not implemented.
2. Membership comes from vault scope, not the plugin's anchored-prefix exclusion quirks.
3. `.md` only.
4. Over-long inputs, note-level and block-level alike, are bounded in tokens by the active profile's tokenizer (below) rather than by the plugin's character cuts.
5. Block keys are unique within a note. The plugin suffixes only a repeated *top-level* heading, leaving two identical sibling sub-headings able to collide — and a collision silently drops a block.
6. Block boundaries come from the CommonMark AST rather than the plugin's line regexes.

### The token window

A tokenizer can declare no real window (a `model_max_length` of 1e15, say), and any input over the model's real window crashes inside ONNX. The corpus does not rely on the tokenizer's own limit, and it does not guess a character budget either: characters per token vary with language and content, so no single character budget fits every note. `EmbeddingService` cuts every input to the profile's `maxTokens` (512 for all shipped profiles) before the forward pass, keeping the model's special-token template intact, and only a work bound of `maxTokens × 32` characters is applied ahead of tokenisation, to keep tokenizer cost finite on multi-megabyte notes. How the cut works is in [`embedding-pipeline.md` § Tokenisation](./embedding-pipeline.md#tokenisation).

## On-disk layout

```
<vault>/.neuro-vault/corpus/
  reconcile.lock               # { host, pid, token, acquired } while a pass runs (any model)
  <model_key>/                 # one per model profile, e.g. harrier-270m/
    manifest.json              # { embed_version, provider, model_key, model_id, revision, dtype, dims, pooling, max_tokens, strategy, created }  (manifest v2)
    notes/<sha256(path)[:32]>.json
```

Each model profile has its own directory, named by its `model_key`: readable on disk and in `--prune` output, and stable across a revision bump, so a profile that moves to a new pinned revision rebuilds its directory in place rather than leaving an orphan behind. Switching `--model` therefore selects a directory; it reads, rewrites and discards nothing of any other model's. A directory name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and, compared case-insensitively, must not be `notes`, `manifest.json` or `reconcile.lock`. The leading-character rule keeps `.`, `..` and dot-directories out of a path segment that a legacy manifest's `model_key` is read into; the three names are the corpus root's own entries, and `Notes` is the same directory as `notes` on a case-insensitive filesystem. All three shipped profile keys pass. The `.gitignore` entry is still the single line `.neuro-vault/corpus/`.

### Migration from the single-corpus layout

Before per-model directories, `manifest.json` and `notes/` sat directly under `.neuro-vault/corpus/`. The first reconcile pass over a vault on this layout moves them into the manifest's own `model_key` directory, under the vault's lock (see [Concurrency](#concurrency-the-reconcile-lock)) and before the manifest is read. Every server start and every `index` run goes through a pass, so every vault migrates on its first pass after the upgrade; `eval` never migrates.

- **How.** It reads the root manifest for its `model_key`, creates `<model_key>/`, renames `notes/` into it, then renames `manifest.json` into it, and writes one stderr line (`neuro-vault corpus: moved the <model_key> corpus of vault <path> into .neuro-vault/corpus/<model_key>/ (one corpus directory per model)`). They are renames, never copies, and nothing is re-embedded: the pass that follows finds every shard in place, so an unchanged vault costs an incremental stat pass and embeds nothing. The manifest moves last, so a migration interrupted between the two renames leaves the root manifest behind and the target without one, and the next pass completes it. A source that has already gone is "already moved", never an error.
- **When it does not move anything.** With no root manifest there is nothing to do. It skips, silently (a warning would repeat on every pass), when the root manifest cannot be read or parsed, when it does not validate as a manifest, or when its `model_key` is not a legal directory name; the pass then works in a fresh directory for the active model, as it would on a new vault. It also skips when `<model_key>/manifest.json` already exists, which leaves the legacy entries where they are.
- **A pre-per-model build still running.** An older build on the same vault keeps using the root layout. Once the migration has moved the root corpus away, that build finds no root manifest and rebuilds at the root once; the new build never reads those files again.
- **Leftovers.** Anything the migration skipped, and anything a pre-per-model build rebuilt at the root afterwards, stays until `neuro-vault-mcp index --prune` removes it (see [Pruning](#pruning-other-models-corpora)).

A corpus whose identity differs from the running build's — a legacy corpus on an older model, say — still migrates into its own key's directory first. It is then never read by a build that selects another model, and `--prune` removes it.

A shard is self-describing, so change detection never consults the manifest:

```json
{
  "path": "Dir/Note.md",
  "content_hash": "<sha256 hex>",
  "mtime": 1756000000000,
  "size": 4096,
  "embedding": "<base64 float32, or null below the gate>",
  "blocks": [{ "key": "#Top", "heading": "Top", "lines": [1, 20], "embedding": "<base64>" }]
}
```

Vectors are base64 of a little-endian `Float32Array`, bit-exact in both directions. A non-little-endian host is rejected rather than silently byte-swapped. Decoding copies the bytes out of the Buffer (`buf.buffer.slice(byteOffset, byteOffset + length)`: a bare `.buffer` would read the whole Buffer pool, and a view would keep the pool's slab alive) into a `Float32Array` that the snapshot keeps as is. It is not widened to a JS `number[]`: the snapshot holds every vector of the corpus for the life of a session, and a number array costs 8+ bytes a dimension (plus the spare capacity `Array.from` grows) against 4. On a 955-note vault with 6 180 vectors (640 dims) that was about 48 MB of live heap against about 16 MB. Ranking reads vectors as `ArrayLike<number>`, so a query vector from the embedder (`number[]`) and a stored one compare without conversion.

Filenames are hashed rather than slugified: vault paths carry spaces, Cyrillic and arbitrary punctuation, and a slug would have to be both collision-free and filesystem-safe. A truncated hash is 128 bits, and the shard carries its own `path` — a mismatch reads as a missing shard, so a collision costs one re-embed, never a wrong vector.

Block entries without a vector are not written at all: in the replaced corpus two thirds of the entries were vector-less.

The corpus lives inside the vault so it travels with it and multi-vault needs no extra bookkeeping. `.neuro-vault/corpus/` is a dot-path, so the vault scope excludes it unconditionally. On each run the indexer ensures the vault's root `.gitignore` ignores the corpus, appending one `.neuro-vault/corpus/` line when the file exists and does not already cover it. It never creates a `.gitignore`, never rewrites another line, and never ignores `.neuro-vault/` as a whole — other things under that directory are meant to be versioned. A failure warns on stderr and never fails indexing.

## The corpus interface

The shard files are the durable form; what reads and writes a model's corpus goes through an interface ([ADR-0019](../adr/0019-embedding-storage-interface.md)), declared in `corpus.ts`:

- `ICorpusReader` — `nearest(anchors, { threshold, limit?, allowed?, exclude? })` and `nearestBlocks(anchors, { paths, threshold, limit? })`. An anchor is `{ vector }` or `{ path }`; one result list comes back per anchor, in order, and `null` for a path anchor whose note carries no vector. `allowed` and `exclude` apply before `limit`.
- `ICorpusWriter` — what reconcile needs: `entries()` (a `Map` of path → `{ content_hash, mtime, size }`, no vectors), `upsert(record)`, `touch(path, stat)` (false when there is no record to touch), `delete(path)`, `identity()` (the stored manifest, or null), `ensureIdentity(expected)` (identity and reset composed: discards the whole corpus when the stored identity differs, and reports `{ rebuilt, previous }`) and `refresh()`.
- `ICorpus` — both, plus `vectorOf(path)` and `dispose()`.

Two implementations exist, both over a `ShardStore`:

- **`ShardCorpus`** (`shard-corpus.ts`) is the corpus a shared process serves reads from. `load()` decodes every shard once into `Float32Array`s (yielding to the event loop every 256 notes) and swaps the result in whole, so a read racing the load sees the old corpus or the new, never a half. Each write goes to the shard file first and to memory only once that resolved, so memory never claims more than disk holds. `refresh()` is `load()` again, for a corpus whose shards another process changed; `size()` counts the notes that can rank. Ranking is the brute-force scan `SearchEngine` runs — the same `scoring.ts` cosine and the same ordering (similarity, then `localeCompare` on path) — so the results are identical, which a parity test pins.
- **`shardWriter(store)`** (`shard-writer.ts`) is a `ICorpusWriter` and nothing else: every call goes to disk and nothing is held in memory (`refresh` is a no-op). It is what `reconcileCorpus` hands `reconcileProfile`, and so what `neuro-vault-mcp index` and the session's current backend run on; a run that reads nothing never decodes a corpus.

`ShardStore` is the former `CorpusStore`, renamed when the interface took the name "corpus"; the one behavioural change is `ensureCorpusDir` below.

### A deleted vault root is never recreated

`ShardStore` writes, the reconcile lock and the legacy-corpus migration create directories lazily, and `mkdir -p` of `<vault>/.neuro-vault/corpus/…` after the vault directory was deleted (or its volume unmounted) would bring back an empty vault that the next scan reads as having no notes, whose shards the pass would then sweep. `ensureCorpusDir(metaDir, dir)` therefore creates `<vault>/.neuro-vault` **non-recursively** — `ENOENT` when the vault root is gone — and only what lies below it recursively. A mount point left behind as an empty directory still passes: it cannot be told from a vault with no notes (an accepted limitation, see [`vault-entry.md`](./vault-entry.md#a-deleted-vault-root-is-unavailable-not-an-empty-vault)).

## Atomic writes, and a corrupt shard is a missing shard

Every shard and manifest write goes through `write-file-atomic` (temp file + rename), so a reader sees either the previous file or the complete new one. On the read side, a shard that fails to read, fails to parse, fails validation, carries a `path` that does not hash back to its filename, or holds a vector whose byte length disagrees with `dims × 4` reads as **absent** and is warned about — the note is simply re-embedded on the next pass. The note on disk is the ground truth, so no corpus damage is fatal.

The one case that throws instead is writing a vector of the wrong dimension: the manifest gate cannot catch it (the store's `dims` and the manifest's `dims` both come from the same provider identity), so it would be written, read back as `null`, and re-embedded forever. Reconcile contains that per-note failure like any other.

## Reconcile

A pass is two functions composed (`reconcile.ts`), so one process can walk several models' corpora of a vault under a single acquisition of the lock:

- **`withReconcileLock(vaultRoot, opts, fn)`** takes the vault's lock, migrates a single-corpus layout (see [Concurrency](#concurrency-the-reconcile-lock) and [Migration](#migration-from-the-single-corpus-layout)), runs `fn({ waited })` and releases in a `finally`. `waited` tells `fn` whether another holder had the lock first; the result is `undefined` when the signal aborted before `fn` ran. Everything below reads the corpus, so a pass that waited sees what the previous holder left.
- **`reconcileProfile(deps, corpus, paths, opts)`** is the per-note loop and orphan sweep for one model, over a `ICorpusWriter` and a path set the caller already scanned. It does not take the lock and does not write the `.gitignore` entry: its caller holds the lock and writes the entry once, after every profile has run.

`reconcileCorpus(deps, opts)` is the composition `index` and the session's current backend use: `withReconcileLock`, one `scan()`, one `reconcileProfile` over `shardWriter(store)`, then the `.gitignore` entry. It takes ports — `scan`, `stat`, `readNote`, `embedDocuments`, a `ShardStore` — and returns `{ total, embedded, added, reused, renamed, deleted, failed }`; `added` is the part of `embedded` that had no record and was not a rename. The vault entry's reconcile loop ([`vault-entry.md`](./vault-entry.md)) calls `withReconcileLock` once, scans once and calls `reconcileProfile` per profile. In order:

0. Take the vault's lock and migrate (`withReconcileLock`, above).
1. `ensureIdentity` (`corpus.ensureIdentity(identity)`, first thing in `reconcileProfile`) compares the stored manifest against the identity the caller passes in — the embedding provider's, under this build's extraction (every manifest field except `created`). A mismatch, or a missing manifest while shards exist, discards every shard of this model's directory and rebuilds it. A scope or exclusion change is **not** a rebuild — membership is not a property of the vectors.
2. Take the scoped path set from `scan()` (run once inside the lock, before `reconcileProfile`) and the records' metadata from `corpus.entries()`. Reconcile applies no exclusion rule of its own.
3. Shards whose path is not in scope become deletion candidates, indexed by content hash — the only place a rename can be recognised.
4. For each path in scope: equal `mtime` **and** `size` → reused, without opening the note. Otherwise read it; an equal `content_hash` → rewrite the shard's metadata and keep the vectors (**reused**); otherwise embed (**embedded**). A path with no shard whose hash matches a deletion candidate is a **rename**: the old shard is unlinked and the note is re-embedded under its new path.
5. Every remaining deletion candidate is unlinked (**deleted**).
6. Ensure the `.gitignore` entry (the caller, once per pass).
7. Release the lock, in a `finally`.

Progress is reported once per processed note as `{ indexed, total }` counted in notes — the shape slice #3 (CLI progress) and slice #5 (`semantic_status`) consume unchanged. A failure to read, embed or store one note is counted in `failed`, warned on stderr, leaves that note's previous shard untouched, and never aborts the run.

### A vector is a function of (path, content, strategy)

Both embed-text formulas carry path breadcrumbs, so reusing a vector across a rename would leave the old path inside it until the note's text next changed — and a corpus maintained incrementally would then differ from one built from scratch. A rename therefore re-embeds, and two notes with identical content at different paths get different vectors. The payoff is a testable invariant: **any sequence of incremental reconciles ending in a given vault state produces the same corpus as a from-scratch index of that state**, modulo `mtime`/`size`.

### An identity change within a model is a rebuild, and never silent

The manifest records everything that determines a stored vector (manifest v2): `embed_version`, `provider`, `model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens` and `strategy`, plus the informational `created`. `isManifestCompatible` compares every field except `created`, so moving a profile to a new pinned `revision`, changing its `dtype`, `pooling` or token window, or bumping `embed_version` or `strategy` each make the stored manifest incompatible. Another `--model` is not on that list: it selects another directory and discards nothing. The directory's corpus is then discarded and re-embedded — vectors from the same model under two configurations do not share a space — and no other model's directory is touched. The query prefix is not in the manifest: it changes no stored vector.

A manifest written before manifest v2 lacks the producer fields (`provider`, `revision`, `dtype`, `pooling`, `max_tokens`). It still parses, as a `StoredManifest` with those fields absent, and it compares as incompatible — so it triggers a rebuild, and the rebuild message can name the `model_key` and `embed_version` it replaces instead of reporting an unreadable manifest. A manifest that cannot be parsed at all, or a missing manifest while shards exist, is named as `an unreadable or missing manifest`.

The rebuild is announced where the user will see it. The server logs one line to stderr at startup — `neuro-vault corpus: vault "<name>" was indexed with <model_key> (embed_version <n>); active model is <model_key> (embed_version <m>) — discarding the corpus and re-indexing in the background` — and `index` prints `rebuilding <name>: corpus was indexed with …; active model is …` (the same two descriptions) before its progress. Only an actual discard is reported: a fresh vault with no corpus yet is not a rebuild. Give `index` the server's `--model` so it pre-warms the corpus the server serves; any other value builds a separate corpus beside it.

## Concurrency: the reconcile lock

Every MCP client session runs its own server process, and `index` runs beside them, so several processes can reconcile one vault at once. Without coordination they rebuilt shards against each other and deleted each other's fresh writes. A pass therefore runs under one lock per vault, shared by every model: `<vault>/.neuro-vault/corpus/reconcile.lock`. `index --prune` takes the same lock; `eval` never does.

- **Taking it.** The file is created exclusively (`wx`) with `{ host, pid, token, acquired }`: this machine's hostname, the process id, a token unique to this acquisition, and a timestamp. Failing because the file exists means someone holds it, and the contender reads it to judge the holder.
- **Live or stale.** A holder on another host is always live: its pid, from another machine or another container's pid namespace, cannot be checked here, and judging it dead would take a live lock away. On this host, a holder is stale when `kill(pid, 0)` reports no such process, or when the pid is this process's own (passes over one vault never overlap within a process, so that is a dead predecessor's pid); a process that exists, even under another user, is live. A lock written without a `host` reads as this host's. A file whose content does not parse is taken to be mid-write for 1 s, timed from when this waiter first saw that file so, then stale. A stale lock is replaced only if the file still holds exactly what was judged stale.
- **Waiting.** A live holder is polled starting at 50 ms, doubling to a 2 s cap, for at most 30 minutes in total — about three times the measured cold index of the default profile on a ~950-note vault, which a holder may also spend downloading its model on a first run. `index` announces the wait once on stderr; a server waits silently and keeps serving its snapshot (it writes one line only on a timeout). A lock path that exists but keeps reading as absent, such as a dangling symlink, is waited on the same way and under the same bound. An abort (the server shutting down) ends the wait without touching the holder's lock.
- **Releasing.** The lock is removed in a `finally`, and only if the file still holds exactly the content this acquisition wrote, token included, so a holder never removes another's lock, even one carrying its own pid. A release failure warns and never throws.
- **A pass that waited reuses what the holder built.** The manifest and shard listing are read after the lock is held, so a corpus that became compatible while waiting gets an incremental pass, and nothing the holder embedded is embedded twice. The server also reloads its snapshot after a pass that waited, whatever the counts say: a note the holder re-embedded counts as `reused` here, so the counts alone would leave this process serving the old vectors (see [`semantic-backend.md`](./semantic-backend.md#live-promotion)).
- **Past 30 minutes.** The server keeps its state and snapshot, writes one stderr line naming the vault, the holder's pid and host and the lock file, and retries on its failure backoff (see [`semantic-backend.md`](./semantic-backend.md#startup-serve-what-you-can-then-catch-up)). `index` writes `waiting for another neuro-vault process (pid <n>[ on <host>]) to finish with <vault>…` on stderr when it starts waiting — the host only when it is not this one, and no parenthesis at all while the holder's pid is unknown — and treats a timeout as that vault's fatal error: a stderr line, the next vault, and a non-zero exit.

Three risks remain, each accepted:

- **A simultaneous stale-steal.** Two waiters judge one dead lock stale in the same instant, and the second removes the first's fresh lock. The conditional removal narrows this to microseconds; the worst case is one pair of overlapping passes, which self-correct on the next pass.
- **Pid reuse.** A holder died and an unrelated live process took its pid, so the lock looks live and every pass waits the full 30 minutes. The server's timeout line names the lock file; deleting the file clears it.
- **A dead holder on another host.** A lock left by a crashed process on another machine or container can never be judged stale from here. The remedy is the same, and taking such a lock over on a guess would bring back the concurrent passes the lock exists to prevent.

Because the lock is per vault and not per model, servers on different models serialise their passes. That is accepted: concurrent cold indexes were half of the CPU in the incident that motivated this layout, and a waiting server keeps serving its own snapshot.

## Pruning other models' corpora

Per-model directories trade disk for a switch that discards nothing: two models' corpora coexist until something removes one. `neuro-vault-mcp index --prune` is that something, and nothing removes a corpus automatically. After reconciling a vault, it takes the vault's lock and deletes every directory directly under `.neuro-vault/corpus/` except the selected model's (other models' directories, and a leftover legacy `notes/`), plus a leftover legacy `manifest.json`. It leaves `reconcile.lock` and any other file. It reports on stdout `pruned <vault>: removed <a>, <b>` or `pruned <vault>: nothing to remove`.

It is skipped for a vault whose reconcile threw: the error prints as `index <vault>: <message>` on stderr and nothing is pruned. It is also skipped for one that returned with notes in scope but none embedded, reused or renamed — what an offline first run of a new model looks like, since embed failures are contained per note — and then stderr says `not pruning <vault>: no note was indexed with <model_key>, so the other models' corpora are kept`. Either way a failed run cannot leave a vault with nothing to serve. Nor can a concurrent prune: two `index --prune` runs on different models could each reconcile, then prune the other's directory, so the prune refuses — removing nothing, and failing that vault with `index <vault>: … the <model_key> corpus has no manifest, so nothing would be left to serve` — when the selected model's corpus is missing by the time it holds the lock. A prune that has to wait for the lock prints the same `waiting for another neuro-vault process …` line as the reconcile. A partial failure, where some notes failed but others were indexed, still prunes. Being under the lock, it never deletes a directory another process is mid-pass in; a server serving a pruned model keeps its in-memory snapshot, and its next pass rebuilds the directory.

## Measured numbers

Cold-index cost depends on the profile: a larger model embeds fewer vectors per second, needs more memory while it does, and writes larger vectors. Measured on Apple silicon (CPU, quantized weights) on one vault for every profile, each profile cold-indexing its own corpus-less clone; the runs shared the CPU with other work, so the times are upper-side:

| | `granite-97m` | `harrier-270m` (default) | `harrier-0.6b` |
| --- | --- | --- | --- |
| Vault indexed (notes / notes with a note vector) | 949 / 888 | 949 / 888 | 949 / 888 |
| Cold index | 3.5 min | 8.8 min | 35.5 min |
| Max RSS while indexing | 1.20 GB | 1.32 GB | 2.40 GB |

The default's 1.32 GB is from this per-profile run; a separate acceptance run of the same vault peaked at 1.58 GB, so expect about 1.3–1.6 GB for `harrier-270m`.

A cold index is minutes for the two smaller profiles and over half an hour for `harrier-0.6b`, so it can never block server startup. After it, only notes that changed are re-embedded. The per-profile retrieval quality that goes with these costs is in [`retrieval-policy.md` § Calibration](./retrieval-policy.md#calibration).

## Boundaries

This is an indexing library, not a runtime — `reconcileCorpus`, `withReconcileLock` and `reconcileProfile` take ports and return a summary; they start nothing on their own and know nothing about watchers, servers, or CLIs. Their callers live elsewhere: the `neuro-vault-mcp index` CLI runs `reconcileCorpus` once per invocation, the per-vault semantic backend of a session runs it at startup and again on every debounced watcher tick ([`semantic-backend.md`](./semantic-backend.md)), and the daemon's vault entry runs the split form, one lock acquisition per pass over every attached profile ([`vault-entry.md`](./vault-entry.md)). Passes over one vault are serialised across processes by `reconcile.lock` (see [Concurrency](#concurrency-the-reconcile-lock)); sharing one watcher and one decoded corpus between sessions is the vault entry's job, not this library's.
