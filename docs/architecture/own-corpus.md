# The Own Corpus

The embedding corpus the server builds and owns: how a note becomes model inputs, where the vectors live, and how the corpus is kept in agreement with the vault. The decision behind it is [ADR-0013](../adr/0013-own-embedding-corpus.md), which supersedes the "the server never writes embeddings" half of [ADR-0006](../adr/0006-smart-connections-corpus.md).

Keeping this corpus fresh once the server is running — the per-vault watcher, its debounce, and who calls `reconcileCorpus` — is not this file's concern. See [`semantic-backend.md`](./semantic-backend.md) and [ADR-0014](../adr/0014-background-corpus-freshness.md).

## What it is

Four pieces, all under `src/lib/obsidian/corpus/` and deliberately free of any import from `src/modules/` — the indexer sees the embedding model only through a one-function port, `EmbedDocumentsFn = (texts: string[]) => Promise<number[][]>`, called once per note with the note-level text and every block text, vectors back in input order. A failed call fails only that note:

| File | Responsibility |
| --- | --- |
| `chunker.ts` | Splits a note into keyed blocks with line spans. |
| `embed-text.ts` | Turns a note and its blocks into the exact strings sent to the model, and applies the size gate. |
| `shard-store.ts` | Reads, writes, lists and deletes shards and the manifest; atomic writes; `.gitignore` upkeep. |
| `reconcile.ts` | Brings the corpus into agreement with the vault. |

`types.ts` holds the shapes and the constants that fix how text becomes vectors: `MIN_CHARS` (200), `EMBED_CHAR_BUDGET` (1894), `SC_PARITY_STRATEGY` and `EMBED_VERSION`. It holds **no model constants**: which model made the vectors is not the corpus's to know. The embedding provider reports an `EmbeddingIdentity` (`model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens` — see [`embedding-pipeline.md`](./embedding-pipeline.md)), and `identity.ts` derives the corpus identity from it: `corpusIdentityOf` projects exactly five fields — `model_key`, `model_id` and `dims` from the provider, plus `embed_version` and `strategy` from this build's corpus constants — and `formatIdentity` names an identity (`<model_key> (embed_version <n>)`) in rebuild messages.

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
note:   breadcrumbs(notePath) + ":\n" + full note text        → cut to EMBED_CHAR_BUDGET chars
```

Breadcrumbs replace `/` and `#` with ` > ` and drop a trailing `.md`. Both formulas carry the note's path — the fact the whole reconcile design turns on.

### The size gate

A note or block is embedded only when its text reaches `MIN_CHARS` (200). A heading block whose span is entirely accounted for by kept sub-blocks is dropped, so a pure container heading is not embedded twice; a heading that also holds text of its own stays. Below-gate notes are still members of the vault and still get a shard — they simply carry no note-level vector.

The gate and the truncation are **content** rules: they decide what text of an included note is embedded, never which notes are included. Membership is [vault scope](vault-scope.md) alone.

### Named divergences from the corpus being replaced

Extraction reproduces the replaced corpus 1:1 so that the one diagnostic run comparing the two backends is interpretable. Six divergences are accepted on purpose:

1. `excluded_headings` is not implemented.
2. Membership comes from vault scope, not the plugin's anchored-prefix exclusion quirks.
3. `.md` only.
4. Over-long **block** inputs are capped by tokens (below) rather than by the plugin's character cut at the last whitespace; both land at ≈512 tokens (the active profile's `maxTokens`). Note-level inputs are cut at 1894 characters exactly as the plugin cuts them.
5. Block keys are unique within a note. The plugin suffixes only a repeated *top-level* heading, leaving two identical sibling sub-headings able to collide — and a collision silently drops a block.
6. Block boundaries come from the CommonMark AST rather than the plugin's line regexes.

### The token window

Some tokenizers declare no real window — `bge-micro-v2` ships `model_max_length = 1e15` in its tokenizer config — and any input over the model's real window crashes inside ONNX. The corpus does not rely on the tokenizer's own limit: `EmbeddingService` cuts every input to the profile's `maxTokens` (512 for all shipped profiles) before the forward pass, keeping the model's special-token template intact. The query path never hit this because queries are short; the indexer hits it on the first long note. How the cut works is in [`embedding-pipeline.md` § Tokenisation](./embedding-pipeline.md#tokenisation).

## On-disk layout

```
<vault>/.neuro-vault/corpus/
  manifest.json                # { embed_version, model_key, model_id, dims, strategy, created }  (a five-field projection of the provider's identity)
  notes/<sha256(path)[:32]>.json
```

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

Vectors are base64 of a little-endian `Float32Array`, decoded through an explicit `byteOffset`/length view (a bare `.buffer` would read the whole Buffer pool) and bit-exact in both directions. A non-little-endian host is rejected rather than silently byte-swapped.

Filenames are hashed rather than slugified: vault paths carry spaces, Cyrillic and arbitrary punctuation, and a slug would have to be both collision-free and filesystem-safe. A truncated hash is 128 bits, and the shard carries its own `path` — a mismatch reads as a missing shard, so a collision costs one re-embed, never a wrong vector.

Block entries without a vector are not written at all: in the replaced corpus two thirds of the entries were vector-less.

The corpus lives inside the vault so it travels with it and multi-vault needs no extra bookkeeping. `.neuro-vault/corpus/` is a dot-path, so the vault scope excludes it unconditionally. On each run the indexer ensures the vault's root `.gitignore` ignores the corpus, appending one `.neuro-vault/corpus/` line when the file exists and does not already cover it. It never creates a `.gitignore`, never rewrites another line, and never ignores `.neuro-vault/` as a whole — other things under that directory are meant to be versioned. A failure warns on stderr and never fails indexing.

## Atomic writes, and a corrupt shard is a missing shard

Every shard and manifest write goes through `write-file-atomic` (temp file + rename), so a reader sees either the previous file or the complete new one. On the read side, a shard that fails to read, fails to parse, fails validation, carries a `path` that does not hash back to its filename, or holds a vector whose byte length disagrees with `dims × 4` reads as **absent** and is warned about — the note is simply re-embedded on the next pass. The note on disk is the ground truth, so no corpus damage is fatal.

The one case that throws instead is writing a vector of the wrong dimension: the manifest gate cannot catch it (the store's `dims` and the manifest's `dims` both come from the same provider identity), so it would be written, read back as `null`, and re-embedded forever. Reconcile contains that per-note failure like any other.

## Reconcile

`reconcileCorpus(deps, opts)` takes ports — `scan`, `stat`, `readNote`, `embedDocuments`, a `CorpusStore` — and returns `{ total, embedded, reused, renamed, deleted, failed }`. In order:

1. `ensureManifest` compares the stored manifest against the identity the caller passes in — the embedding provider's, under this build's extraction (`embed_version`, `model_key`, `model_id`, `dims`, `strategy`). A mismatch, or a missing manifest while shards exist, discards every shard and rebuilds. A scope or exclusion change is **not** a rebuild — membership is not a property of the vectors.
2. Take the scoped path set from `scan()` and the shard map from `listShards()`. Reconcile applies no exclusion rule of its own.
3. Shards whose path is not in scope become deletion candidates, indexed by content hash — the only place a rename can be recognised.
4. For each path in scope: equal `mtime` **and** `size` → reused, without opening the note. Otherwise read it; an equal `content_hash` → rewrite the shard's metadata and keep the vectors (**reused**); otherwise embed (**embedded**). A path with no shard whose hash matches a deletion candidate is a **rename**: the old shard is unlinked and the note is re-embedded under its new path.
5. Every remaining deletion candidate is unlinked (**deleted**).
6. Ensure the `.gitignore` entry.

Progress is reported once per processed note as `{ indexed, total }` counted in notes — the shape slice #3 (CLI progress) and slice #5 (`semantic_status`) consume unchanged. A failure to read, embed or store one note is counted in `failed`, warned on stderr, leaves that note's previous shard untouched, and never aborts the run.

### A vector is a function of (path, content, strategy)

Both embed-text formulas carry path breadcrumbs, so reusing a vector across a rename would leave the old path inside it until the note's text next changed — and a corpus maintained incrementally would then differ from one built from scratch. A rename therefore re-embeds, and two notes with identical content at different paths get different vectors. The payoff is a testable invariant: **any sequence of incremental reconciles ending in a given vault state produces the same corpus as a from-scratch index of that state**, modulo `mtime`/`size`.

### A model change is a rebuild, and never silent

Switching `--model` changes the manifest's `model_key`, `model_id` and (when the profiles differ) `dims`, and a bump of `embed_version` or `strategy` changes the rest; any difference in those five fields makes the stored manifest incompatible, so the whole corpus is discarded and re-embedded — vectors from two models do not share a space. The other fields the provider reports (`provider`, `revision`, `dtype`, `pooling`, `max_tokens`) are not recorded or compared yet, so a change to only one of them (say a profile moving to a new pinned revision under the same key) does not trigger a rebuild. The rebuild is announced where the user will see it. The server logs one line to stderr at startup — `neuro-vault corpus: vault "<name>" was indexed with <stored> (embed_version <n>); active model is <active> (embed_version <m>) — discarding the corpus and re-indexing in the background` — and `index` prints `rebuilding <name>: corpus was indexed with …; active model is …` before its progress. Only an actual discard is reported: a fresh vault with no corpus yet is not a rebuild. Run `index` and the server with the same `--model`, or each will rebuild the other's corpus.

## Measured numbers

On an 842-note vault (Apple silicon, `bge-micro-v2` quantized, batch 1; measured before the move to `@huggingface/transformers` 4):

| | |
| --- | --- |
| Cold index | **138 s** for 842 notes / 5 423 vectors, ~40 vectors/s |
| No-op reconcile of the same vault | **0.09 s**, 842 reused, 0 embedded |
| Corpus on disk | ~13 MB |

Two figures from the pre-design benchmarks of the same execution path, not from this run: ~90 ms to re-embed one median note on a warm model, and 68 ms to cold-load 2 500 shards from a synthetic corpus.

A cold index is minutes, so it can never block server startup; an incremental pass is free enough to run on every save.

## Boundaries

This is an indexing library, not a runtime — `reconcileCorpus` takes ports and returns a summary; it starts nothing on its own and knows nothing about watchers, servers, or CLIs. Both of its callers live elsewhere: the `neuro-vault-mcp index` CLI runs it once per invocation, and the per-vault semantic backend runs it at startup and again on every debounced watcher tick — see [`semantic-backend.md`](./semantic-backend.md). Cross-process locking is still out of scope: concurrent indexers (two server processes, or a server and a concurrent `index` run) are structurally safe — atomic per-shard writes, self-correcting on the next pass — but do duplicate work.
