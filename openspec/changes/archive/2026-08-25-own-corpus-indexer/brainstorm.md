# Brainstorm — own-corpus-indexer

Raw capture. Format: background → decision chain → trade-offs.

**Provenance note.** The brainstorming for this change did not happen in this
session. It happened inside the wayfinder effort "own embedding pipeline"
(`.scratch/own-embedding-pipeline/`, label `wayfinder:map`), as research and
grilling sessions with the user, resolved 2026-08-22/23:

- [`issues/01-sc-parity-anatomy.md`](../../../.scratch/own-embedding-pipeline/issues/01-sc-parity-anatomy.md)
  + [`research/01-sc-parity-anatomy.md`](../../../.scratch/own-embedding-pipeline/research/01-sc-parity-anatomy.md)
  — how the replaced corpus chunks and embeds, and the 1:1-vs-simplify checklist.
- [`issues/02-storage-options.md`](../../../.scratch/own-embedding-pipeline/issues/02-storage-options.md)
  + [`research/02-storage-options.md`](../../../.scratch/own-embedding-pipeline/research/02-storage-options.md)
  — storage candidates benchmarked and compared.
- [`issues/03-throughput-measurement.md`](../../../.scratch/own-embedding-pipeline/issues/03-throughput-measurement.md)
  + [`research/03-throughput-measurement.md`](../../../.scratch/own-embedding-pipeline/research/03-throughput-measurement.md)
  — measured cold-index cost on the live vault, plus the tokenizer trap.
- [`issues/05-storage-and-location.md`](../../../.scratch/own-embedding-pipeline/issues/05-storage-and-location.md)
  — the accepted format, location and manifest schema.
- [`issues/09-final-task-slicing.md`](../../../.scratch/own-embedding-pipeline/issues/09-final-task-slicing.md)
  — the slicing decision that makes this slice #2 of a six-change queue.

That directory is uncommitted scratch, so this file transcribes the decisions
rather than relying on the links surviving: every decision the implementation
depends on is restated below. It does not re-open them. Three slice-local calls
the map left to the implementation slice were confirmed with the user in this
session (Q10–Q12), and one upstream decision is corrected here (Q13). The
user's instruction was explicit: "беремо задачку #82".

## Background

Semantic search today reads a corpus the server does not own: Smart Connections
(an Obsidian plugin) writes `.smart-env/multi/*.ajson`, and
`smart-connections-loader.ts` parses it read-only. ADR-0006 made that a
deliberate invariant — "the server never writes embeddings" — because owning an
index meant a model, an indexing pass, and staleness management.

Two of those three costs have since evaporated. The query side already embeds
its own vectors (`src/modules/semantic/embedding-service.ts`, transformers.js +
`TaylorAI/bge-micro-v2`), so the model is already a dependency and already
loaded. And ticket 03 measured the indexing pass on the live vault: a full cold
reindex is ~1.5 min (up to ~3.3 min at full SC-parity chunking), ~90 ms per
changed note incrementally, 272 MB peak RSS. What remains is staleness
management — which is this change's reconcile.

What the migration buys: semantic search stops depending on an Obsidian install
and a third-party plugin, stops inheriting a corpus that is measurably dirty
(1075 sources against 866 real `.md` files; `multi/` last written 2026-07-27),
and gets its membership from the same `VaultScope` the lexical leg uses
(slice #1, shipped in 15.4.0).

Slice #1 (`unified-vault-scope`) answered "which files". This slice answers
"what text, what vectors, where stored, and how kept fresh" — as an internal
indexing function only. Server integration, the watcher, live promotion and the
CLI are later slices (#3 `cli-index-command`, #5 `own-backend-integration`).

## Decision chain

Q1–Q9 restate the map's resolutions (tickets 01, 03, 05, 09). Q10–Q12 were
confirmed with the user in this session.

### Q1 — Own corpus, or keep consuming Smart Connections?

Own corpus. ADR-0006's premise ("embeddings come for free from a plugin the
user already runs") holds only for users who run that plugin; the plugin's
corpus is also stale and its format is plugin-internal. Ticket 07 went further
than the original charting decision: SC is not kept as a fallback — it is
deleted entirely in the final slice. So this change is where the ADR-0006
invariant flips, and it carries a new ADR that supersedes that half of it.

### Q2 — How faithful should the embed text be to SC?

**1:1, deliberately, in v1.** Both formulas reproduced verbatim (ticket 01
checklist, ticket 05):

- Block: `breadcrumbs("/" → " > ", drop the last heading segment, drop ".md")`
  + `"\n"` + block text.
- Note: `breadcrumbs(path) + ":\n" + full note text`, truncated to
  `max_tokens × 3.7` characters = **1894** for bge-micro-v2.
- Gate: `min_chars: 200` for both sources and blocks, plus SC's rule that a
  block fully covered by sub-blocks which will themselves be embedded is
  skipped.

The reason is diagnostic, not aesthetic: the parity run (issue #87) compares
`--backend sc` against `--backend own` on the same golden set. If v1 changes
both the storage *and* the text, a worse result is unattributable. With 1:1,
`eval(own v1) ≈ eval(SC)` proves the pipeline is correct, and improvements
(first candidate: note vector as the mean of its block vectors — zero extra
model calls) land afterwards behind an `embed_version` bump, switched by the
harness if they score ≥ on the golden set.

The note-level truncation is the ugliest thing being reproduced: for a long
note the "note vector" means "path + first ~1900 characters", not "the note".
Reproducing it anyway is what makes v1 an anchor.

### Q3 — Chunking

Header-based, levels 1–6, reproducing SC's key grammar because block keys are
identity in the corpus index: hierarchical `#H1#H2`, numbered sub-chunks
`#{n}`, frontmatter as `#---frontmatter---`, pre-heading text as `#`, `[2]`
suffix for duplicate top-level headings, headings inside code fences ignored.
Line spans are 1-based inclusive, and a heading block spans its whole section
including children (so parent and child spans overlap).

### Q3a — Where "1:1" is knowingly not 1:1

Three divergences from SC are already accepted upstream and are not bugs to fix
here:

- **`excluded_headings` is not implemented** (ticket 04, point 8). SC can blank
  named heading blocks out of both the block set and the note-level embed text.
  The live `smart_env.json` has it empty, so the feature is unused and buys no
  parity. If it is ever wanted: separate step, `embed_version` bump.
- **Membership comes from `VaultScope`, not from SC's exclusion quirks**
  (ticket 04, point 6). SC's `file_exclusions: "Untitled"` compiles to an
  anchored prefix glob, so it drops root `Untitled.md` while still embedding
  `Notes/Untitled.md`. We do not reproduce that; the one known membership diff
  against the SC corpus is root `Untitled.md`, already documented in
  `docs/architecture/vault-scope.md` and to be noted during the parity diff.
- **`.md` only** (ticket 05). SC has canvas/base adapters; the live corpus has
  exactly one `.base` source, which disappears.
- **Block keys are unique within a note.** SC suffixes a repeated *top-level*
  heading (`#Title[2]`) but disambiguates repeated sub-headings only through
  its numbered content chunks, which leaves two identical sibling sub-headings
  able to produce the same key — and both SC's `blocks` map and ours are keyed
  maps, so a collision silently loses a block. We suffix at every level
  instead. Uniqueness is an invariant our loader needs; matching SC's ambiguity
  here would buy nothing measurable.

Bit-level vector parity with SC is not a goal anywhere — the only comparison
that matters is eval metrics on the golden set (ticket 05).

### Q4 — Storage format

One JSON shard per note (vectors as base64 of a `Float32Array`) plus a separate
`manifest.json`; atomic writes via `write-file-atomic` (ISC, pure JS).

Rejected, with reasons from ticket 02's benchmark: AJSON (append log + tombstones
+ compaction, weaker I/O guarantees than temp+rename, 3.8× larger vectors as JSON
numbers); LanceDB (155–227 MB platform binary, no darwin-x64 prebuild → silent
install / runtime crash on Intel Macs — fatal for `npx`); hnswlib-node
(`node-gyp rebuild` on every install, `saveIndex` without temp+rename, and ANN
buys nothing at 15k × 384 where brute force is < 10 ms); sqlite (both
`better-sqlite3` v13 and built-in `node:sqlite` raise the Node floor to ≥ 22
against our `>= 20` — kept as the fallback plan if the floor ever rises).

Measured cold-load of 2 500 shards / 15 000 vectors: **68 ms** with
`Promise.all`. Storage is not the bottleneck at this scale; zero native
dependencies is what decides it.

### Q5 — Where the corpus lives

Inside the vault: `.neuro-vault/corpus/`. Precedent is `.smart-env`, multi-vault
works for free (the corpus travels with its vault), and moving a vault does not
lose the index. It must not be committed to the vault's git repo.

### Q6 — What to simplify against SC

Since the format is one-way (only our loader reads it):

- No vector-less block records. In the live SC corpus 15 730 of 23 064 block
  entries have no vector — the corpus is ~3× smaller without them.
- `.md` only (SC has canvas/base adapters; one `.base` source disappears).
- No append log, no tombstones, no compaction: a shard is always exactly the
  current state, a deleted note is an `unlink`.
- Shards are self-describing (`content_hash`, `mtime`, `size` inside the shard),
  so change detection never has to read the manifest.
- A shard whose vectors do not have the manifest's dimension is rejected as
  corrupt. The corpus loader being replaced throws on mixed dimensions across
  the corpus (parity checklist item 8); since we write the corpus ourselves,
  the equivalent guard belongs at the shard boundary, where it costs one
  length check and repairs itself by re-embedding. The manifest is small and
  is written only when `embed_version` / `strategy` / model identity changes.

### Q7 — Change detection

Full reconcile = diff of path sets (scope-scanned paths vs shard paths):

- `mtime` + `size` are a cheap pre-check, never the truth.
- `content_hash` is the truth.
- A rename is a hash match at a new path (see Q13 — the shard is reused for
  bookkeeping, but the vectors are recomputed).
- Config-driven membership changes need no `embed_version` bump — the next
  reconcile simply reflects the current scope (ticket 04).

### Q8 — The tokenizer trap

Ticket 03 found it the hard way: bge-micro-v2's cached `tokenizer_config.json`
sets `model_max_length = 1e15`, so `truncation: true` inside the transformers.js
pipeline does nothing, and any input over 512 tokens crashes ONNX
(`Attempting to broadcast an axis... 512 by N`). Ukrainian note text at 1894
characters exceeds 512 tokens routinely. The current `EmbeddingService` never
hits this because it only ever embeds short queries — the indexer would hit it
on the first long note. The indexer must either set
`tokenizer.model_max_length = 512` after creating the pipeline or pre-truncate
by characters the way SC's adapter does.

### Q9 — What this slice deliberately excludes

No server integration, no watcher, no live promotion, no CLI, no contract
changes to any MCP tool. The deliverable is an internal indexing function plus
its storage, exercised by tests. That keeps the biggest slice in the queue
reviewable and leaves the observable-behaviour changes to slices #3 and #5.

### Q10 — Block parity: full 1:1 or leaf-only? *(this session)*

**Full 1:1.** Reproducing SC's `should_embed` keeps overlapping parent heading
blocks: ~7–8k vectors and ~3.3 min for a cold index on the live vault, against
~2.7k vectors and ~1.5 min for a leaf-only cut. The cheaper cut was rejected for
the same reason as Q2 — it would make the parity run compare two different
chunkings, so a worse-than-SC number would be ambiguous.

### Q13 — Rename: re-embed or reuse the vectors? *(this session — corrects ticket 06)*

Ticket 06 decided "rename detected by hash match, shard renamed **without**
re-embed". That optimization is unsound against the Q2 extraction: both
parity formulas put path breadcrumbs into the embed text (note:
`dir > note:\n…`; block: `dir > note > H1\n…`), so a vector is a function of
**(path, content, strategy)**, not of content alone. Renaming a shard without
re-embedding leaves the old path baked into every vector of that note until
its content next changes.

**Resolved: re-embed on rename.** ~90 ms per renamed note (~18 s for a
200-note folder move, in background) buys an exact invariant — an incremental
corpus is always byte-identical to a from-scratch reindex of the same vault.
Without it the eval harness (#84) could score two corpora that differ only by
edit history, which is exactly the ambiguity Q2 exists to remove. The same
reasoning kills a content-hash "copy detection" shortcut: two notes with
identical content at different paths do not share vectors.

What survives of ticket 06's rule is the *detection*, not the shortcut:
`content_hash` still identifies a renamed note cheaply (no re-chunking needed
to decide what happened), and the `mtime`+`size` pre-check still keeps
unchanged notes from being read at all.

### Q11 — Who writes the vault's `.gitignore` line? *(this session)*

**The indexer, best-effort.** On first index, if the vault root has a
`.gitignore` that does not already ignore the corpus, append
`.neuro-vault/corpus/`. Any failure is a stderr warning, never fatal, and the
file is never rewritten beyond that one appended line. Rejected: a documented
manual step (a vault owner who skips it commits ~30 MB of vectors), and
ignoring all of `.neuro-vault/` (issue #84 wants `eval/golden.yaml` committed).

This is the server writing into a user file outside `.neuro-vault/` — the one
place this change reaches beyond its own directory. It is bounded to appending
a single line, and only when a `.gitignore` already exists.

### Q12 — One PR or two? *(this session)*

**Two.** PR 1 = extraction + storage (chunker, embed-text builder, shard/manifest
writer, atomic writes). PR 2 = reconcile + docs (hash diff, rename detection,
the new ADR revising ADR-0006, `docs/architecture/own-corpus.md`). Delivery
pauses between them.

## Design trade-offs

- **Fidelity vs quality, resolved as "fidelity first".** Everything about the
  extraction is knowingly imperfect (note vector = first 1894 chars, overlapping
  parent blocks, a 200-char gate that drops short notes entirely). v1 keeps all
  of it so the parity run means something; the improvement track is a separate
  effort gated on the eval harness.
- **Self-describing shards vs a fat manifest.** Change detection reads shards,
  not the manifest, so a torn or missing manifest cannot desynchronize
  incremental updates — at the cost of `readdir` + parse of every shard on
  reconcile (68 ms at 2 500 notes, measured).
- **Corpus in the vault vs an XDG cache dir.** In-vault wins on multi-vault and
  on portability, and loses on "the tool writes into my notes folder" — mitigated
  by the dot-prefix (already always excluded by scope) and the `.gitignore` line.
- **Zero native dependencies is a hard constraint, not a preference.** The
  package is consumed via `npx`; anything that compiles on install or ships a
  200 MB platform binary is a distribution regression, which is what
  disqualified the two fastest-on-paper options.

## Still open (deliberately, for later slices)

- How the index is triggered at runtime (watcher, debounce, startup reconcile) —
  slice #5, decided in ticket 06.
- What the tools report while an index is building (`semantic_status`,
  `SEMANTIC_INDEX_BUILDING`) — slice #5, decided in ticket 07.
- Whether the improved note-vector strategy replaces the SC-parity one — gated on
  the eval harness (#84) and the golden set (#86), behind an `embed_version` bump.
