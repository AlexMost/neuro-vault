## Context

The server's semantic leg reads a corpus it does not produce. A third-party
Obsidian plugin writes `.smart-env/multi/*.ajson`; `smart-connections-loader.ts`
parses it read-only into `Map<string, SmartSource>`, and ADR-0006 made
"the server never writes embeddings" an invariant, because owning an index meant
a model, an indexing pass and staleness management.

Two of those costs are already paid. `EmbeddingService`
(`src/modules/semantic/embedding-service.ts`) already loads
`TaylorAI/bge-micro-v2` through transformers.js for query embedding, and the
indexing pass was measured on the live vault: 40.4 vectors/s warm, a full cold
index in ~1.5 min (up to ~3.3 min at exact SC-parity chunking), ~90 ms per
changed note, 272 MB peak RSS. The third cost — staleness — is what this change
implements as reconcile.

The constraints that shape every decision below:

- **Distribution.** The package is consumed via `npx`. No dependency may
  compile on install or ship a large platform binary, and the Node floor stays
  at `>= 20`.
- **Membership is already solved.** Slice #1 (`unified-vault-scope`, 15.4.0)
  gave every vault entry one `VaultScope`, consumed through `FsVaultReader.scan`.
  The indexer takes its path set from there and inherits scope for free.
- **Parity is a measurement instrument.** The parity run (#87) compares the two
  backends on one golden set. That only means something if v1 changes the
  storage without changing the text.
- **This slice ships no observable behaviour.** No tool contract changes and
  nothing serves from the new corpus; slices #3 and #5 do that.

## Goals / Non-Goals

**Goals:**

- Derive embed inputs from a note deterministically, at parity with the corpus
  being replaced: header chunking, hierarchical block keys, line spans, both
  embed-text formulas, truncation, the `min_chars` gate.
- Persist a corpus the server owns under `<vault>/.neuro-vault/corpus/`, with
  atomic writes and no native dependencies.
- Reconcile that corpus against the vault incrementally: unchanged notes cost a
  `stat`, changed notes cost one re-embed, deleted notes cost an `unlink`.
- Keep one exact invariant: **a vector is a pure function of (path, content,
  strategy)**, so an incrementally maintained corpus is identical to a
  from-scratch reindex of the same vault.
- Leave a seam the later slices consume without rework: an internal indexing
  function plus a store that can be read into the existing `SmartSource` shape.

**Non-Goals:**

- Serving semantic search from the new corpus, live promotion, watcher,
  `semantic_status` / `SEMANTIC_INDEX_BUILDING`, the `neuro-vault index` CLI
  (slices #3 and #5).
- Improving retrieval quality. Every known weakness of the SC extraction is
  reproduced on purpose; improvements are a separate effort behind an
  `embed_version` bump, arbitrated by the eval harness (#84).
- Bit-level vector equality with the corpus being replaced. The only comparison
  that matters is eval metrics on the golden set.
- Deleting any Smart Connections code — that is slice #6, gated on the parity run.
- Cross-process coordination. One indexer per vault at a time is assumed.

## Decisions

### D1 — The indexer lives in `src/lib/obsidian/corpus/`, not inside the semantic module

- **Choice**: extraction, storage and reconcile go under
  `src/lib/obsidian/corpus/` (chunker, embed-text builder, shard store,
  reconcile, types), mirroring where the corpus loader it replaces already sits.
  The indexer depends on the embedding model only through a narrow port it
  declares itself — `type EmbedFn = (text: string) => Promise<number[]>` —
  which `EmbeddingService` satisfies structurally.
- **Rationale**: `src/lib/` is what both a module and the CLI may import;
  `src/modules/semantic/` is not (module-structure: modules do not call each
  other, shared data lives in `src/lib/`). Slice #3 wires a CLI command and
  slice #5 wires the registry — both would otherwise have to import through a
  module boundary. The port also inverts the dependency: `lib` never imports
  from `modules`, and tests inject a deterministic fake embedder instead of
  loading a 17 MB ONNX model.
- **Alternatives considered**: `src/modules/semantic/indexer/` — natural home
  by subject matter, rejected because the CLI slice would import a module's
  internals; passing `EmbeddingProvider` from `modules/semantic/types.ts` —
  rejected, it points the dependency arrow the wrong way.

### D2 — Extraction reproduces the replaced corpus 1:1, with three named divergences

- **Choice**: header chunking at levels 1–6; hierarchical block keys
  (`#H1#H2`, numbered sub-chunks `#{n}`, `#---frontmatter---` for frontmatter,
  `#` for pre-heading text, `[2]` for duplicate top-level headings, headings
  inside code fences ignored); 1-based inclusive line spans where a heading
  block spans its whole section including children; block embed text =
  breadcrumbs (`/` → ` > `, last heading segment dropped, `.md` dropped) + `\n`
  + block text; note embed text = path breadcrumbs + `:\n` + full text
  truncated to `max_tokens × 3.7` = **1894** characters; `min_chars: 200` gate
  for both notes and blocks, plus the rule that a block fully covered by
  sub-blocks which will themselves be embedded is skipped.
- **Rationale**: diagnostic anchor. With extraction held fixed,
  `eval(own v1) ≈ eval(replaced corpus)` proves the pipeline; a divergence is
  attributable to storage or reconcile, not to text. Reproducing the gate also
  reproduces its shape: the corpus keeps overlapping parent-heading blocks
  (~7–8k vectors on the live vault against ~2.7k for a leaf-only cut), which is
  what makes the two corpora comparable at all.
- **Named divergences** (accepted upstream, not defects):
  1. `excluded_headings` is not implemented — the feature is unused in practice
     and buys no parity.
  2. Membership comes from `VaultScope`, not from the plugin's anchored-prefix
     exclusion quirks; the one known membership diff is a root-level
     `Untitled.md`, already documented in `docs/architecture/vault-scope.md`.
  3. `.md` only.
  4. Over-long **block** inputs: the plugin's adapter pre-truncates by
     characters at the last whitespace; we cap by tokens instead (D3). Both land
     at ≈512 tokens, the cut point differs by a few characters. Note-level
     inputs are unaffected — the 1894-character cut is reproduced exactly.
  5. Block keys are unique within a note. The plugin suffixes a repeated
     *top-level* heading (`#Title[2]`) but leaves two identical sibling
     sub-headings able to collide on one key; both its block map and ours are
     keyed maps, so a collision silently drops a block. We apply the suffix at
     every level. Uniqueness is an invariant the corpus depends on, and the
     ambiguity is not worth reproducing.
  6. Block scanning is CommonMark-correct via the AST
     (`mdast-util-from-markdown`, already a runtime dependency and already how
     the lexical leg parses notes in `src/lib/obsidian/lexical/blocks.ts`),
     not a reproduction of the plugin's line-regex quirks. The regex's failure
     mode was silent content loss — a line it mis-attributed landed in no
     block at all, never embedded, nothing reporting it — and it had four
     known holes: a ` ``` ` line inside a `~~~` fence flipped the toggle,
     fences of four or more backticks went unrecognised, four-space-indented
     code was invisible to it, and its fence regex's `^\s*` mis-fired on
     indented content. Parity with the corpus being replaced has a shelf life
     of exactly one measurement run (#87), after which the plugin is removed
     (slice #6); correctness ships permanently to strangers who install via
     `npx` into vaults nobody here has seen, which is the wrong side of that
     trade. No corpus exists on any user's disk yet, so this was also the
     cheapest moment the swap will ever be — after the backend integration
     slice it would cost every user an `embed_version` rebuild. The AST
     decides *where* a heading is and its level; the raw source line still
     decides the title text, so `# **Bold** title` and `# Title ###` keep the
     keys they had. Two behaviour changes are accepted as CommonMark-correct:
     an ATX heading indented one to three spaces now opens a block (the regex
     required column 0), and a `#` line inside an HTML block no longer does —
     an HTML block that runs on absorbs following headings until a blank line
     ends it. Setext headings (`Title` over `====` or `----`) still do not
     open blocks, since the spec is ATX-only and a paragraph sitting directly
     above a `---` is common enough that minting a heading keyed on a whole
     sentence would be a nasty surprise in someone else's vault; a heading
     with an empty title (`#` alone) still does not open one either, since its
     key would collide with the preamble block's `#` and block keys must be
     unique within a note (divergence 5).
- **Alternatives considered**: leaf-only blocks (3× smaller corpus, ~2× faster
  index) — rejected, it would make the parity run compare two different
  chunkings, so a worse-than-baseline number would be unattributable;
  improving the note vector now (mean of block vectors, zero extra model calls)
  — deferred to a post-baseline `embed_version` bump for the same reason.

### D3 — Cap the tokenizer at the service, pre-truncate at the indexer

- **Choice**: after creating the pipeline, `EmbeddingService` sets
  `tokenizer.model_max_length = 512` (guarded — a missing tokenizer property
  must not throw); the indexer additionally applies the parity character
  truncation to note inputs.
- **Rationale**: the cached `tokenizer_config.json` for this model ships
  `model_max_length = 1e15`, so the pipeline's internal `truncation: true` is a
  no-op and **any input over 512 tokens crashes ONNX**
  (`Attempting to broadcast an axis... 512 by N`). The query path never hit it
  because queries are short; the indexer hits it on the first long note or long
  block. The cap belongs in the service because it is a property of the model,
  not of the caller, and it protects every future caller; the character
  truncation stays in the indexer because it is a parity rule, not a safety rule.
- **Alternatives considered**: character pre-truncation only — rejected, block
  inputs have no parity truncation rule of their own, so nothing would protect
  them; passing `truncation: true` explicitly — rejected, it is already passed
  internally and is precisely what does not work here.

### D4 — One self-describing JSON shard per note, plus a small manifest

- **Choice**:

  ```
  .neuro-vault/corpus/
    manifest.json              { embed_version, model_key, dims, strategy, created }
    notes/<hash>.json          { path, content_hash, mtime, size,
                                 embedding: "<base64 f32>" | null,
                                 blocks: [{ key, heading, lines: [s,e],
                                            embedding: "<base64 f32>" }] }
  ```

  Vectors are base64 of a little-endian `Float32Array`. Change-detection
  metadata lives **inside the shard**, so reconcile never consults the manifest.
- **Rationale**: search is brute-force cosine over an in-memory map, so storage
  owes us only fast cold load, cheap single-note updates and crash safety. All
  three are satisfied without a database: measured cold load of 2 500 shards is
  68 ms with `Promise.all`, and base64 float32 is 3.8× smaller and ~20× faster
  to decode than JSON numbers while staying bit-exact. Self-describing shards
  mean a lost or torn manifest cannot desynchronize incremental updates.
- **Alternatives considered**: the plugin's AJSON format (append log +
  tombstones + compaction, and its durability is a bare `appendFile` — weaker
  than temp+rename); LanceDB (155–227 MB platform binary, no darwin-x64
  prebuild → silent install then a runtime crash on Intel Macs); hnswlib-node
  (`node-gyp rebuild` on every install, non-atomic index write, and ANN buys
  nothing at this scale where brute force is < 10 ms); sqlite in both forms
  (`better-sqlite3` v13 and built-in `node:sqlite` require Node ≥ 22 against our
  `>= 20`) — kept as the documented fallback if the floor ever rises; one file
  for the whole corpus (28 ms cold load, but every note save rewrites ~31 MB).
- **Note-level `embedding: null`** is legal and meaningful: a note under the
  `min_chars` gate has blocks-or-nothing, and the shard still records its hash
  so reconcile does not re-read it every pass.

### D5 — Shard filenames are hashed, not slugified

- **Choice**: `notes/<sha256(path) truncated to 32 hex chars>.json`, with the
  real `path` inside the shard.
- **Rationale**: the replaced format slugifies the path by replacing
  `[\s/.]` with `_`, which is lossy — two distinct notes can collide on one
  filename. Reconcile reads every shard anyway (they are self-describing), so
  filename readability buys nothing, while a flat directory keeps `readdir`
  cheap and `unlink` trivial. A 128-bit prefix makes accidental collision a
  non-event, and a shard whose stored `path` does not match the file it was
  found under is treated as missing (D7) rather than trusted.
- **Alternatives considered**: mirroring the vault tree under `notes/` —
  readable, but adds `mkdir -p` per write and empty-directory cleanup on
  delete; the plugin's slug — rejected as lossy.

### D6 — The corpus lives in the vault, and the indexer appends one `.gitignore` line

- **Choice**: `<vault>/.neuro-vault/corpus/`. On first index, if the vault root
  has a `.gitignore` that does not already ignore the corpus, append
  `.neuro-vault/corpus/`. Failure of that append is a stderr warning, never
  fatal; no `.gitignore` is created if none exists; nothing else in the file is
  rewritten.
- **Rationale**: in-vault storage makes multi-vault work by construction (the
  corpus travels with its vault) and survives a vault move; the dot-prefix means
  scope already excludes it unconditionally. The `.gitignore` line prevents a
  vault owner from committing ~30 MB of vectors, which is a footgun a doc note
  does not reliably prevent. Only `corpus/` is ignored, not all of
  `.neuro-vault/` — the eval golden set (#86) is meant to be committed.
- **Alternatives considered**: an XDG cache directory outside the vault
  (loses portability and needs its own per-vault keying); a documented manual
  step (a skipped step costs the user a 30 MB commit); ignoring
  `.neuro-vault/` wholesale (conflicts with #84/#86).
- **Boundary note**: this is the one write this change makes outside its own
  directory. It is bounded to appending a single line to an existing file. The
  "already ignored" check compares literal lines (`.neuro-vault/corpus/` and its
  obvious spellings, plus a whole-`.neuro-vault/` entry); it does not evaluate
  gitignore semantics, so a vault that excludes the corpus only through a
  broader wildcard gets one redundant — harmless — line.

### D7 — Atomic writes, and a corrupt shard is a missing shard

- **Choice**: every shard and the manifest are written through
  `write-file-atomic` (temp + `rename`, ISC, pure JS). On read, a shard that
  fails to parse, fails schema validation, or carries a `path` inconsistent with
  its filename is treated as absent — the note is re-embedded on the next pass.
  Nothing about corpus corruption is fatal.
- **Rationale**: POSIX `rename` gives "old or new, never torn" without a
  database. Recovery is free because the note itself is ground truth — the same
  property the replaced format relied on, without its append log. Writing our
  own temp+rename helper was considered and rejected: the edge cases (fsync
  ordering, temp-name collisions, concurrent writes to one path) are exactly
  what the dependency has already solved.
- **Dimension is part of validation.** A shard whose decoded vectors do not
  have the manifest's dimension is corrupt by the same rule. The loader being
  replaced throws on mixed dimensions across the corpus (parity checklist
  item 8) — writing the corpus ourselves lets the guard sit at the shard
  boundary instead, where it is one length check and repairs itself by
  re-embedding rather than taking the process down.

### D8 — Manifest compatibility is a full-rebuild switch

- **Choice**: the manifest carries `embed_version` (integer, bumped when
  extraction or embedding semantics change), `model_key`, `dims`, `strategy`
  (the extraction strategy id, `"sc-parity-v1"` for this slice) and `created`.
  Reconcile compares the on-disk manifest against the running configuration; on
  any mismatch — or a missing/unparsable manifest with shards present — every
  shard is discarded and the corpus is rebuilt. It is written only when it
  changes.
- **Rationale**: mixing vectors from two models or two extraction strategies
  produces silently meaningless similarities; the loader it replaces already
  throws on mixed dimensions for the same reason. A rebuild is ~1.5–3.3 min and
  happens only on a deliberate version change.
- **Not a rebuild trigger**: a scope/exclusion change. That is a membership
  change, not a vector change — the next reconcile drops out-of-scope shards and
  embeds newly in-scope notes, `embed_version` untouched.

### D9 — Reconcile: `mtime`+`size` pre-check, `content_hash` truth, re-embed on rename

- **Choice**: reconcile diffs the scoped path set against the shard set:
  1. unchanged `mtime` **and** `size` → skip without reading the file;
  2. otherwise read, hash; hash equal → rewrite the shard's metadata only, no
     re-embed;
  3. hash differs, or no shard → embed;
  4. a shard whose path left scope or disk → `unlink`;
  5. a note whose `content_hash` matches a vanished shard is recognised as a
     rename — the old shard is unlinked and **the note is re-embedded**.
- **Rationale for the rename correction** (this supersedes the upstream
  decision, which assumed path-independent vectors): both parity embed-text
  formulas carry path breadcrumbs — a note's own vector begins with
  `dir > note:` and every block's begins with `dir > note > H1`. A vector is
  therefore a function of **(path, content, strategy)**. Reusing vectors across
  a rename would bake the old path into them until the note's text next
  changed, so an incrementally maintained corpus could differ from a
  from-scratch reindex of the same vault — precisely the ambiguity D2 exists to
  eliminate, and one the eval harness could not see. Cost: ~90 ms per renamed
  note, ~18 s for a 200-note folder move. What survives of the upstream rule is
  the *detection* — the hash still identifies the note cheaply and lets the old
  shard be removed as a rename rather than as a delete-plus-add.
- **The same reasoning rules out content-hash vector sharing** between two
  distinct notes with identical text: different paths, different vectors.
- **Alternatives considered**: keeping the shortcut (instant bulk moves, but a
  reproducibility gap under the harness); applying it to blocks only (same gap,
  subtler, and no clean invariant).

### D10 — Membership comes from the scoped scan, never from a second rule

- **Choice**: the indexer takes a reader port (`scan()` + note reads) and uses
  `FsVaultReader`, which is already scope-aware, as its production
  implementation. It never applies exclusion rules of its own; `min_chars` and
  truncation are content rules, not membership rules.
- **Rationale**: this is why slice #1 shipped first. One definition means the
  lexical and semantic legs cannot disagree about which notes exist, and it
  closes the gap that `docs/architecture/vault-scope.md` currently names as
  "not governed yet — the semantic leg".

### D11 — Sequential embedding with a progress callback

- **Choice**: notes are processed in sorted order, one embed call at a time
  (batch = 1, matching the current service and the replaced pipeline). The
  indexing function accepts an optional progress callback receiving
  `{ indexed, total }` counted in **notes**, and returns a summary
  (`embedded`, `reused`, `renamed`, `deleted`, `skipped`, `failed`).
- **Rationale**: throughput was measured on exactly this path, so the numbers
  hold; batching and parallelism are an untested speedup that would change the
  measured baseline mid-migration. The counters cost nothing here and are
  exactly what slice #5 needs for `semantic_status: { state: "indexing",
  indexed, total }` and slice #3 for CLI progress — defining them now avoids a
  contract retrofit.
- **Per-note failure is contained**: an embedding or write failure for one note
  is recorded in `failed`, leaves the previous shard untouched, and does not
  abort the run.

### D12 — Internal function only; no wiring, no contract change

- **Choice**: this slice exports an indexing function and a store. Nothing calls
  them at runtime — no registry wiring, no watcher, no CLI, no MCP surface
  change. Exercised by tests.
- **Rationale**: this is the largest slice in the queue and the only one that
  can be reviewed purely on its own logic. Keeping observable behaviour at zero
  means a bug here cannot degrade search before the eval harness exists to
  detect it.
- **Where the seam stops**: the store's read surface is `Map<path, CorpusShard>`
  with vectors still base64. Slice #5's `SemanticBackend.snapshot()` owes its
  callers `{ sources: Map<path, SmartSource>, basenameIndex }`, so the shard →
  `SmartSource` adapter (decode vectors, build the basename index) belongs to
  that slice, next to the promotion logic that needs it. Stated here so the
  boundary is a decision rather than an oversight.

### D13 — A new ADR supersedes half of ADR-0006

- **Choice**: add `docs/adr/0013-own-embedding-corpus.md`, recording that the
  server now builds and owns an embedding corpus, superseding ADR-0006's "the
  server never writes embeddings" decision while leaving its
  read-only-consumption record intact as history. ADR-0006 gets a status note
  pointing forward. Plus `docs/architecture/own-corpus.md` as the living
  mechanism doc, and the "not governed yet" paragraph in
  `docs/architecture/vault-scope.md` updated.
- **Rationale**: ADRs are immutable records; reversing one is itself a decision
  that needs its own entry (ADR-0008 / the repo's doc split). This is mandated
  by the tracking issue.

## Risks / Trade-offs

- **[Risk] ONNX crashes on any input over 512 tokens** (the tokenizer trap) →
  Mitigation: D3 caps the tokenizer in the service; a regression test embeds a
  fixture that exceeds 512 tokens and asserts it returns a vector rather than
  throwing.
- **[Risk] The server now writes inside the user's vault** → Mitigation: writes
  confined to a dot-directory scope always excludes; every write atomic; the
  only write outside it is one appended `.gitignore` line, best-effort, warning
  on failure, never fatal.
- **[Risk] Two processes indexing one vault concurrently** (two MCP clients, or
  a CLI run beside a server) → Mitigation: atomic per-shard writes make the
  corpus structurally safe (last writer wins on a shard, no torn files), and a
  shard that loses a race is corrected on the next reconcile. Not solved:
  duplicated embedding work. A lock is deliberately deferred to slice #5, which
  owns the runtime lifecycle.
- **[Risk] Truncated-hash filename collision** → Mitigation: 128 bits, plus the
  shard carries its own `path` and a mismatch is treated as a missing shard,
  so a collision costs one re-embed, never a wrong vector.
- **[Trade-off] Shipping known-suboptimal extraction** (a long note's vector is
  "path + first 1894 characters"; parent blocks overlap their children) →
  Accepted: parity is what makes the parity run interpretable. The improvement
  path is already defined — `embed_version` bump, arbitrated by the harness.
- **[Trade-off] Reconcile reads and parses every shard** (68 ms at 2 500 notes)
  → Accepted: it is what makes shards self-describing and the manifest
  non-load-bearing.
- **[Trade-off] Re-embedding renames costs ~18 s for a 200-note folder move** →
  Accepted (D9): exact reproducibility is worth more than instant bulk moves,
  and the work happens in the background once slice #5 wires it.
- **[Trade-off] Corpus format is one-way and versioned by us** → Accepted: only
  our loader reads it, which is what allows dropping the vector-less block
  records (~2/3 of the replaced corpus's entries) and the append log entirely.
- **[Risk] Storage format outgrows JSON shards later** → Mitigation: the store
  is behind an interface and `node:sqlite` is the documented successor once the
  Node floor allows it; `embed_version` + full rebuild is the migration path.

## Migration Plan

No deployment change: nothing in the runtime path executes this code in this
slice, so the release is additive and rollback is a revert.

Delivery is **two PRs** with a pause between them (one change ≠ one bundled PR):

1. **PR 1 — extraction + storage.** Chunker, embed-text builder, tokenizer cap,
   shard/manifest store with atomic writes, `.gitignore` append, unit tests and
   fixtures. `Refs #82`.
2. **PR 2 — reconcile + docs.** Reconcile with the `mtime`/`size` pre-check,
   hash truth, rename handling and per-note failure containment; the summary and
   progress callback; ADR-0013 superseding ADR-0006; `docs/architecture/own-corpus.md`;
   the `vault-scope.md` update. `Closes #82`.

Acceptance for each PR: `npm test`, `npm run lint`, `npm run typecheck` green,
plus `openspec validate --all`. The corpus written by PR 1 is inert; if PR 2 is
delayed, nothing is left in a half-wired state.

## Open Questions

None blocking. Deliberately deferred, with an owner:

- Indexing lifecycle at runtime — watcher, debounce, startup reconcile, live
  promotion, and a cross-process lock: slice #5 (`own-backend-integration`).
- What the tools report while an index builds (`semantic_status`,
  `SEMANTIC_INDEX_BUILDING`): slice #5.
- Whether an improved note-vector strategy replaces the parity one: gated on the
  eval harness (#84) and golden set (#86), behind an `embed_version` bump.
- Whether the shard store moves to `node:sqlite`: only if the Node floor rises
  to ≥ 22 for other reasons.
