Tracked by: #82

## Why

Semantic search reads a corpus the server does not own: a third-party Obsidian plugin writes it, `smart-connections-loader.ts` parses it read-only, and ADR-0006 froze that as an invariant. The premise has expired — the query side already loads its own embedding model, and a full cold index of the live vault measures ~1.5–3.3 min (~90 ms per changed note), so "owning an index is too expensive" is no longer true. Meanwhile the inherited corpus is measurably stale (1075 sources against 866 real notes, last written a month before measurement) and its membership cannot be reconciled with the lexical leg's. This slice builds the corpus the server owns: extraction, storage, and incremental reconcile — the core of the migration off Obsidian plugins.

## What Changes

**Who produces the embedding corpus**

- From: an Obsidian plugin writes `.smart-env/multi/*.ajson`; the server only parses it and never writes embeddings (ADR-0006).
- To: the server derives embed inputs from note text, embeds them with the model it already loads, and writes a corpus it owns under `<vault>/.neuro-vault/corpus/`.
- Reason: drop the dependency on an Obsidian install and a third-party plugin; get a corpus that is fresh by construction and shares its membership definition with the lexical leg.
- Impact: reverses half of ADR-0006 — carried by a new ADR that supersedes it. No user-visible behaviour changes in this slice: nothing serves from the new corpus yet.

**Embed-text extraction (new, at parity with the existing corpus)**

- From: no extraction code — embed inputs arrive pre-computed inside the plugin's corpus.
- To: header-based chunking (levels 1–6) with hierarchical block keys, 1-based inclusive line spans, both embed-text formulas reproduced (block = breadcrumbs without the last heading segment + text; note = path breadcrumbs + full text truncated to `max_tokens × 3.7` characters), and the `min_chars: 200` gate including the "skip a block fully covered by embedded sub-blocks" rule.
- Reason: parity is a diagnostic anchor, not an aesthetic goal — the parity run (#87) compares backends on one golden set, so v1 must change the storage without changing the text. Improvements land later behind an `embed_version` bump.
- Impact: non-breaking. Accepted divergences: `excluded_headings` is not implemented (unused in practice), `.md` only, membership comes from the vault scope rather than the plugin's exclusion quirks, and block boundaries come from parsing the note as CommonMark rather than reproducing the plugin's line-regex fence/indentation/HTML-block quirks.

**Corpus storage (new)**

- From: no storage of our own.
- To: one self-describing JSON shard per note (vectors as base64 `Float32Array`; `content_hash`, `mtime`, `size` inside the shard) plus a small `manifest.json`; every write atomic via `write-file-atomic`; corpus lives inside the vault at `.neuro-vault/corpus/`, and the indexer appends `.neuro-vault/corpus/` to the vault's root `.gitignore` best-effort when one exists.
- Reason: zero native dependencies is a distribution constraint for an `npx` package — the two fastest-on-paper stores are disqualified by a `node-gyp` install and a 200 MB platform binary with no darwin-x64 prebuild. Measured cold-load of 2 500 shards is 68 ms, so storage is not the bottleneck at this scale.
- Impact: new runtime dependency `write-file-atomic`; the server now writes inside the vault, in a dot-directory the scope always excludes.

**Incremental reconcile (new)**

- From: staleness is the plugin's problem; the server compensates at the read edge.
- To: reconcile diffs the scoped path set against the shard set — `mtime` + `size` are a cheap pre-check, `content_hash` is the truth, a hash match at a new path identifies a rename, a vanished path is an `unlink`. Vectors are a function of (path, content, strategy) — both parity embed-text formulas carry path breadcrumbs — so a renamed note is re-embedded rather than having its shard silently reused; this corrects an upstream decision that assumed path-independent vectors. A membership change needs no `embed_version` bump.
- Reason: the corpus must be cheap to keep fresh; ~90 ms per changed note makes incremental the normal path and full reindex the exception.
- Impact: non-breaking — the reconcile function has no caller in this slice.

**Out of scope, deliberately**: server integration, the file watcher, live promotion, `semantic_status` / `SEMANTIC_INDEX_BUILDING`, the `neuro-vault index` CLI, and any MCP tool-contract change. Those are slices #3 (`cli-index-command`) and #5 (`own-backend-integration`). Nothing reads the new corpus yet; Smart Connections still serves every semantic tool.

## Capabilities

### New Capabilities

- `embed-text-extraction`: how a note becomes model inputs — header chunking and block-key grammar, line spans, the two embed-text formulas, truncation, and the size gate. Deterministic and independent of storage.
- `own-corpus-index`: the corpus the server owns — on-disk layout and shard/manifest schema, atomic-write and crash-recovery guarantees, membership from the vault scope, and incremental reconcile by content hash including rename detection.

### Modified Capabilities

- `vault-scope`: corpus membership joins the surfaces the one scope definition governs — the requirement currently enumerates scan-derived surfaces only and states the semantic leg is explicitly not governed.

## Impact

- **Code**: new indexer under `src/modules/semantic/` (chunker, embed-text builder, shard/manifest store, reconcile); `EmbeddingService` gains the tokenizer cap that the query path never needed (`model_max_length = 512` or character pre-truncation — without it any input over 512 tokens crashes ONNX, and 1894-character note inputs exceed it routinely).
- **Dependencies**: `write-file-atomic` added (ISC, pure JS). No native dependencies, no Node-floor change — the sqlite options were rejected precisely because they require Node ≥ 22 against our `>= 20`.
- **Vault side effects**: writes under `<vault>/.neuro-vault/corpus/`; appends one line to the vault's root `.gitignore` when the file exists and does not already ignore the corpus (best-effort, stderr warning on failure, never fatal).
- **Tests**: extraction fixtures asserting block keys, spans and both embed-text formulas; storage round-trip including base64 vector fidelity and atomic-write behaviour; reconcile cases (unchanged, modified, added, deleted, renamed, membership change), including the invariant that an incremental run and a from-scratch reindex produce identical corpora.
- **Docs**: new ADR superseding the "server never writes embeddings" half of ADR-0006; new `docs/architecture/own-corpus.md`; scope-doc update where it says the semantic leg is not yet governed.
- **Not touched**: MCP tool surface and parameter dictionary, `search_notes` output contract, the Smart Connections loader and corpus index, `--semantic` flag semantics, retrieval policy and rank fusion.
