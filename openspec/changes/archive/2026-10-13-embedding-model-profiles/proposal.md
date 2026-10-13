Tracked by: #98

## Why

The only embedding model, `bge-micro-v2`, cannot serve Ukrainian: on the owner's golden set its UA MRR is 0.317, below the issue's 0.4 gate, while `harrier-oss-v1-270m` reaches 0.695 with English unchanged (bake-off, 2026-10). The model is a hardcoded constant read in six places, so swapping it today means editing constants and hoping every consumer agrees. The bake-off also found two latent bugs any model swap trips over: transformers.js drops the EOS of truncated inputs (noise for last-token models), and the 3.7 chars/token budget matches no model. The hosted hub (#126) may embed through a remote API, so the swap must land as a provider seam, not a new constant.

## What Changes

**Which model embeds a vault**

- From: `TaylorAI/bge-micro-v2` (384 dims, mean pooling), hardcoded; `index` cannot choose a model.
- To: a closed registry of verified model profiles selected by `--model` on the server and on `index`: `harrier-270m` (default; 640 dims, last-token, query instruction prefix), `granite-97m` (lite; 384 dims, CLS), `harrier-0.6b` (quality; 1024 dims, last-token). An unknown key is rejected with the list of allowed keys. One profile per process, as today.
- Reason: Ukrainian retrieval quality; a closed set keeps every selectable model one that was measured and verified against the pinned library version.
- Impact: **breaking** in effect (not in contract): every corpus rebuilds once on upgrade; the default model is ~344 MB int8 (was 17 MB) and peaks near 2 GB RSS; cold index on the owner's vault goes from ~2 min to ~6–11 min.

**Who owns tokenization**

- From: `pipeline('feature-extraction')` tokenizes, adds special tokens, then truncates — losing the trailing EOS of every over-long input.
- To: the local provider encodes raw ids, truncates them to the profile's `max_tokens` minus the special-token template derived from the tokenizer, re-attaches the template, pads on the tokenizer's declared side, and pools per profile (mean / CLS / last-token). Query and document embedding are separate calls, so the query instruction prefix is a profile property callers cannot forget.
- Reason: last-token models embed noise without it (Qwen3 scored 0.164 before the fix, 0.611 after).
- Impact: internal; the `EmbeddingProvider` contract gains `identity`, `embedQuery`, `embedDocuments`.

**How note text is bounded**

- From: note embed text is cut at `EMBED_CHAR_BUDGET` = 1894 characters (512 × 3.7).
- To: no character budget; inputs are truncated by the active profile's tokenizer to `max_tokens`.
- Reason: measured chars/token is 1.6–2.9, never 3.7.
- Impact: part of the one forced rebuild.

**Corpus identity and mismatch reporting**

- From: manifest `{embed_version 1, model_key, model_id, dims, strategy}`; a mismatching corpus is discarded and rebuilt without saying why.
- To: manifest records everything that produced the vectors (provider, model key, repo id, pinned revision, dtype, dims, pooling, max tokens, strategy), `embed_version` 2. A mismatch is named — server stderr warning per vault, a line in `index` output — before the background rebuild; eval refuses to run against a corpus built by another profile.
- Impact: non-breaking for tool output (`semantic_status` already reports `indexing`).

**Indexing throughput**

- From: one embed per call.
- To: a note's inputs are embedded in length-bucketed batches of up to 8; queries keep their priority lane and wait for at most one batch.

**Similarity thresholds**

- From: module constants on bge-micro's scale (`search_notes` 0.5 / 0.35 / 0.3, `expansion_floor` 0.35, `get_similar_notes` 0.5, `find_duplicates` 0.9).
- To: per-profile values, recalibrated with `npm run eval` against the bge-micro baseline; tool descriptions show the active profile's values.
- Impact: default threshold values change; parameter names and schemas do not.

**Eval harness**

- To: `npm run eval -- --model <key>`; the report records the profile identity and per-result similarities; `--stats` emits the distributions threshold calibration needs.

**Delivery**: four PRs — (1) transformers.js 4.x + profile registry (`bge-micro-v2` transitional default, `granite-97m`) + `--model` + mismatch reporting; (2) provider-owned tokenization + batching + harrier profiles; (3) eval `--model` + thresholds become profile data (values unchanged); (4) default switch, manifest v2, char budget removed, recalibrated thresholds, ADR-0017, docs. PRs 1–3 carry `Refs #98`; PR 4 carries `Closes #98`.

## Capabilities

### New Capabilities

- `embedding-model-profiles`: the closed registry of verified model profiles and what a profile pins; `--model` selection shared by the server and `index`; one profile per process; the provider contract (identity, query vs document embedding); provider-owned, template-aware tokenization and pooling; per-profile similarity thresholds.

### Modified Capabilities

- `embed-text-extraction`: the note formula loses its character budget; the context-window bound becomes token truncation that preserves the profile's special-token template.
- `own-corpus-index`: the manifest records the full producing identity at `embed_version` 2; a mismatch is reported, not silent; a note's inputs are embedded in batches without widening failure containment beyond the note.
- `semantic-backend-lifecycle`: the process-wide model is the `--model` profile; query latency during indexing is bounded by one batch in flight; startup names a manifest mismatch before rebuilding.
- `cli-index-command`: `--model` with server parity; the rebuild reason is printed.
- `cli-startup-flags`: adds the `--model` flag.
- `retrieval-eval`: adds the model axis, a manifest-vs-profile gate, profile identity and similarities in reports, and calibration statistics.
- `hybrid-search`: threshold, fallback, block-evidence and `expansion_floor` defaults become the active profile's values instead of fixed literals.

## Impact

- **Dependencies**: `@xenova/transformers` ^2.17 → `@huggingface/transformers` 4.x (brings `onnxruntime-node` 1.x). Model cache location moves with the package; first run re-downloads.
- **Code**: `src/modules/semantic/` (new `model-profiles.ts`; `embedding-service.ts` rewritten; `embed-queue.ts`, `types.ts`, `effort-profiles.ts`, `index.ts`, tools' threshold defaults, `backend/corpus-backend.ts`), `src/lib/obsidian/corpus/` (`types.ts`, `embed-text.ts`, `reconcile.ts`, `shard-store.ts`), `src/config.ts`, `src/types.ts`, `src/server.ts`, `src/cli-index.ts`, `eval/`.
- **CI**: a job that loads each profile's real tokenizer at its pinned revision (cached) to assert the derived template.
- **Docs**: `docs/architecture/embedding-pipeline.md`, `own-corpus.md`, `semantic-backend.md`, `retrieval-policy.md`, `cli-startup.md`, `mcp-parameter-dictionary.md`, `module-structure.md`; `docs/guide/` (configuration, installation, finding-notes); `README.md`; `eval/README.md`; new ADR-0017 + `docs/adr/INDEX.md`.
- **Users**: one full re-index on upgrade (automatic in the background, or `neuro-vault-mcp index`); the server and `index` must use the same `--model` on a vault or they rebuild against each other.
