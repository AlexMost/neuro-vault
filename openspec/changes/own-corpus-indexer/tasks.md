Delivery is two PRs (design.md §Migration Plan). Groups 1–6 are **PR 1**
(`Refs #82`), groups 7–11 are **PR 2** (`Closes #82`). Stop after group 6 and
hand the PR over before starting group 7.

Parallelism is marked per group: **[sequential]** means the group depends on an
earlier one; **[parallel-safe]** means it shares no files or state with the
other groups at the same marker and can be dispatched concurrently.

## 1. Corpus types and ports — PR 1 [sequential, do first]

- [x] 1.1 Add `src/lib/obsidian/corpus/types.ts`: `CorpusBlock` (`key`, `heading`, `lines`, `embedding`), `CorpusShard` (`path`, `content_hash`, `mtime`, `size`, `embedding: string | null`, `blocks`), `CorpusManifest` (`embed_version`, `model_key`, `dims`, `strategy`, `created`), and the narrow `EmbedFn = (text: string) => Promise<number[]>` port. No imports from `src/modules/` (design D1).
- [x] 1.2 Add the extraction-side types: `ExtractedBlock` (key, heading, lines, text, size) and `ExtractedNote` (path, note embed text or null, blocks marked for embedding). Assert with a type-level test or a compiling fixture that `src/lib/obsidian/corpus/` imports nothing from `src/modules/`.
- [x] 1.3 Define the strategy constant (`SC_PARITY_STRATEGY = 'sc-parity-v1'`), `EMBED_VERSION`, and the model-derived character budget (`max_tokens × 3.7`) in one place both extraction and the manifest read from.

> Delivered as `ChunkedBlock` and `NoteEmbedInputs` — plan.md carries the compiling definitions under those names and every downstream task's Interfaces block references them. `EmbedInput`, listed in plan.md's Task 1, was dropped: nothing in either PR consumes it.

## 2. Markdown chunker — PR 1 [parallel-safe with 3, 4, 5]

- [x] 2.1 Failing test → implementation: split a note at ATX headings levels 1–6, emitting 1-based inclusive line spans where a heading block's span covers its whole section including nested subsections (spec: "A note is chunked into keyed blocks by its headings").
- [x] 2.2 Failing test → implementation: headings inside fenced code blocks do not start a block, and the enclosing section's span stays unbroken.
- [x] 2.3 Failing test → implementation: hierarchical block keys `#H1#H2` where separator repetition encodes the child's real level, so a skipped level is visible in the key.
- [x] 2.4 Failing test → implementation: frontmatter becomes `#---frontmatter---` with the fence delimiters inside its span; pre-heading text becomes `#`; content chunks under a heading take `#{n}`; a repeated top-level heading takes the `[2]`-style suffix.
- [x] 2.5 Failing test → implementation: block keys are unique within a note — a heading repeated among siblings at any level takes an occurrence suffix, not just a repeated top-level heading (design D2, divergence 5).
- [x] 2.6 Fixture test: one representative note (frontmatter + preamble + nested headings + a code fence containing a `#` line) asserted whole — keys and spans together — as the chunker's golden output.

> After review, block scanning moved from hand-rolled line regexes to the CommonMark AST
> (`mdast-util-from-markdown`), because the regex scanner's failure mode was silent content
> loss and a package shipped via `npx` into unseen vaults cannot rely on that risk staying
> dormant — see design.md D2, divergence 6.

## 3. Embed text and the size gate — PR 1 [parallel-safe with 2, 4, 5]

- [x] 3.1 Failing test → implementation: block embed text = breadcrumbs (`/` → ` > `, final heading segment dropped, trailing `.md` removed) + `\n` + block text.
- [x] 3.2 Failing test → implementation: note embed text = path breadcrumbs + `:\n` + full text, truncated to the character budget from 1.3 (1894 for the 512-token default), cut without regard to word boundaries.
- [x] 3.3 Failing test → implementation: the 200-character gate for notes and blocks, plus the rule that a block entirely covered by sub-blocks which are themselves marked for embedding is skipped, while a parent holding text of its own outside them stays marked.
- [x] 3.4 Failing test → implementation: a note below the gate yields no note-level embed text but still yields its qualifying blocks.
- [x] 3.5 Test: extraction is deterministic and path-dependent — the same (path, content) yields byte-identical output twice, and the same content at a different path yields different note-level and block embed texts (spec: "Extraction is deterministic", "Moving a note changes its embed text").

## 4. Tokenizer cap in the embedding service — PR 1 [parallel-safe with 2, 3, 5]

- [x] 4.1 Failing test → implementation: `EmbeddingService` caps the tokenizer at the model's real maximum sequence length after pipeline creation, guarded so a pipeline without a reachable tokenizer property does not throw (design D3).
- [x] 4.2 Test: an input whose tokenization exceeds the window returns a vector of the model's dimension instead of raising. Use a fake pipeline for the unit test; add one integration-style test behind the real model only if the suite already tolerates loading it.

## 5. Shard store and manifest — PR 1 [parallel-safe with 2, 3, 4]

- [x] 5.1 Add `write-file-atomic` as a runtime dependency; record in the PR description that it is ISC and pure JS (no native build, Node floor unchanged).
- [x] 5.2 Failing test → implementation: base64 ↔ `Float32Array` codec, bit-exact round-trip, decoding through an explicit `byteOffset`/length view (never a bare `.buffer`), with a guard rejecting a non-little-endian host.
- [x] 5.3 Failing test → implementation: shard path derivation — `notes/<sha256(path) truncated to 32 hex>.json` — and shard write/read through `write-file-atomic`.
- [x] 5.4 Failing test → implementation: a shard that fails to parse, fails validation, or carries a `path` inconsistent with its filename reads as absent, never throws (spec: "Every corpus write is atomic and corruption is recoverable").
- [x] 5.5 Failing test → implementation: a shard holding a vector whose length differs from the manifest's `dims` reads as absent (parity checklist item 8 — the replaced loader throws on mixed dimensions; ours repairs instead).
- [x] 5.6 Failing test → implementation: `listShards()` reads every shard into a `Map<path, shard>` for reconcile, skipping unreadable ones.
- [x] 5.7 Failing test → implementation: manifest read/write and the compatibility predicate over `embed_version`, `model_key`, `dims`, `strategy`; manifest written only when those values change; missing-or-unreadable manifest with shards present reads as incompatible.
- [x] 5.8 Failing test → implementation: best-effort `.gitignore` append — one `.neuro-vault/corpus/` entry, only when the root `.gitignore` exists and does not already ignore the corpus, other lines untouched, idempotent across runs, failure warns on stderr and never throws (design D6).

## 6. PR 1 gates and delivery [sequential]

- [x] 6.1 `npm test`, `npm run lint`, `npm run typecheck`, `npx openspec validate --all` all green; paste the output in the PR body.
- [x] 6.2 Open PR 1 (`Refs #82`) covering groups 1–5 and stop. Do not start group 7 before it is merged.

## 7. Reconcile core — PR 2 [sequential, needs 1–5 merged]

- [x] 7.1 Failing test → implementation: reconcile diffs the scoped path set (from a reader port satisfied by `FsVaultReader`) against `listShards()`; unchanged `mtime` **and** `size` skips the note without reading it (spec: "Reconcile is incremental and hash-truthful").
- [x] 7.2 Failing test → implementation: differing `mtime`/`size` but matching `content_hash` rewrites shard metadata only, reusing vectors; differing hash, or no shard, embeds.
- [x] 7.3 Failing test → implementation: a shard whose note left disk or left scope is unlinked, and nothing else is touched.
- [x] 7.4 Failing test → implementation: manifest incompatibility discards every shard and rebuilds; an exclusion-only change does not (spec: "The manifest records corpus identity and gates a rebuild").
- [x] 7.5 Test: reconcile over an untouched vault embeds nothing, deletes nothing, and is idempotent across repeated runs.

> `ReconcileDeps` carries a `stat` port alongside `readNote`, which plan.md's Task 10 interface block does not list. Without it "unchanged `mtime` and `size` skips the note **without reading it**" is unimplementable — the only metadata source would be the read itself. The test asserts the pre-check leaves `readNote` uncalled.

## 8. Rename handling and the reproducibility invariant — PR 2 [sequential, needs 7]

- [x] 8.1 Failing test → implementation: a note whose `content_hash` matches a shard at a vanished path is recognised as a rename — old shard unlinked, note re-embedded under its new breadcrumbs, new vectors differing from the stored ones (design D9).
- [x] 8.2 Failing test → implementation: two distinct notes with identical content do not share vectors.
- [x] 8.3 Property-style test: a vault reached by a sequence of incremental reconciles (edit, rename, delete, re-add, exclusion change) produces a corpus identical to a from-scratch index of the same final state, with a deterministic fake embedder making vectors a checkable function of (path, content).

## 9. Progress, summary and failure containment — PR 2 [sequential, needs 7]

- [x] 9.1 Failing test → implementation: the index function accepts a progress callback receiving `{ indexed, total }` counted in notes, with the final report having both equal.
- [x] 9.2 Failing test → implementation: the run returns a summary of `embedded` / `reused` / `renamed` / `deleted` / `failed`.
- [x] 9.3 Failing test → implementation: a read, embed or store failure for one note is recorded in `failed`, leaves that note's previous shard untouched, and does not abort the run.
- [ ] 9.4 Sanity check against the real vault outside the test suite: run a full index and an immediate second reconcile through a scratch script, and record wall-clock, vector count and the second run's summary in the PR body. Do not add the script to the repo — the CLI is slice #3.

## 10. Documentation — PR 2 [parallel-safe among 10.1–10.4, after 8 and 9 land]

- [ ] 10.1 Add `docs/adr/0013-own-embedding-corpus.md`: the server now builds and owns an embedding corpus, superseding ADR-0006's "the server never writes embeddings" decision; record the alternatives from design.md §D4 and the distribution constraint that decided them.
- [ ] 10.2 Add a status/supersession note to `docs/adr/0006-smart-connections-corpus.md` pointing forward to ADR-0013, and add the new entry to `docs/adr/INDEX.md`.
- [ ] 10.3 Add `docs/architecture/own-corpus.md`: extraction rules and their named divergences, shard/manifest schema, atomic-write and recovery guarantees, the reconcile algorithm, and the "vector = f(path, content, strategy)" invariant with why a rename re-embeds. One concept, one file.
- [ ] 10.4 Update `docs/architecture/vault-scope.md` — the "Not governed yet — the semantic leg" paragraph and the forward reference to this slice — plus any `docs/guide/` statement about where embeddings come from. Sweep all of `docs/`, not just `docs/architecture/`.

## 11. PR 2 gates and delivery [sequential]

- [ ] 11.1 `npm test`, `npm run lint`, `npm run typecheck`, `npx openspec validate --all` all green; paste the output in the PR body.
- [ ] 11.2 Confirm the slice stayed internal: no MCP tool contract change, no registry or server wiring, no watcher, no CLI, and Smart Connections still serves every semantic tool.
- [ ] 11.3 Open PR 2 (`Closes #82`), then run `/opsx:verify` before archiving.
