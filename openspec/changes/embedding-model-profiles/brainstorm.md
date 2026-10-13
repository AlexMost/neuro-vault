# Brainstorm — embedding-model-profiles (#98)

Raw decision log. Path: **architectural** (dependency major bump, `EmbeddingProvider` contract change, corpus identity change, new CLI flag). Source of truth for the model decision is `docs/research/2026-10-embedding-model-bakeoff.md` and the last comment on #98; this log does not re-litigate it.

## Background

- Today: one hardcoded model, `TaylorAI/bge-micro-v2` (384 dims, mean pooling) through `@xenova/transformers` v2 `pipeline('feature-extraction')`. Identity lives in constants in `src/lib/obsidian/corpus/types.ts` (`MODEL_KEY`, `MODEL_ID`, `MODEL_DIMS`, `MAX_TOKENS`, `EMBED_CHAR_BUDGET`, `SC_PARITY_STRATEGY`, `EMBED_VERSION`) read directly by `reconcile.ts`, `corpus-backend.ts`, `shard-store.ts`, `embedding-service.ts`, `config.ts`, `eval/run.ts`.
- Bake-off result (golden set, 21 UA / 4 EN, note-level semantic): bge-micro UA MRR 0.317 → harrier-270m 0.695. Every candidate clears the issue's UA MRR > 0.4 gate; the current model fails it.
- Three implementation facts from the bake-off: (1) transformers.js truncates after the post-processor, so last-token models lose their EOS on any input over the cap; (2) `EMBED_CHAR_BUDGET`'s 3.7 chars/token matches no model; (3) one model per process is already the invariant (`createQueuedEmbedder` in `server.ts`, one embed fn in the `index` CLI).
- `server.ts` builds exactly one `EmbeddingService` + one queue; `index` builds its own `EmbeddingService()` with the default model — it has no way to pick a model today.
- The corpus manifest gate (`ensureManifest` / `isManifestCompatible`) already discards and rebuilds a corpus whose `{embed_version, model_key, model_id, dims, strategy}` differs. The server's startup selection reports such a vault as `indexing` and rebuilds in the background — **silently**: nothing says why the corpus was thrown away.
- Similarity thresholds are module constants calibrated to bge-micro's scale: `search_notes` quick 0.5 / deep 0.35 / fallback 0.3 / `expansion_floor` 0.35, `get_similar_notes` 0.5, `find_duplicates` 0.9. Tool descriptions interpolate some of them.

## Settled before this change (from the user's brief — not revisited)

1. Default local model: `microsoft/harrier-oss-v1-270m` via `onnx-community/harrier-oss-v1-270m-ONNX`, int8 (`dtype: 'q8'`), 640 dims, last-token pooling, query prefix `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: `, documents bare.
2. Model is a `--model` parameter on the server and the `index` CLI, from a **closed** set of verified profiles only: `harrier-270m` (default), `granite-97m` (lite: `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`, 384 dims, CLS, no prefixes), `harrier-0.6b` (quality: `onnx-community/harrier-oss-v1-0.6b-ONNX`, 1024 dims, last-token, same prefix). No arbitrary repo ids. Profile = repo id + model_key + dims + pooling + prefixes + special-token template + max_tokens.
3. One profile per process (D7). Each vault's manifest is checked against the active profile at load; a mismatch means the vault needs a re-index, reported explicitly, never silently.
4. Provider-agnostic embedding path behind `EmbeddingProvider`; local transformers.js is one implementation; the hub (#126, Linux) may use a remote API. The manifest records what produced the vectors.

## Decision chain

### Q1. How is the work split into PRs, and does the user's 3-PR sketch hold?

The brief sketched: (1) transformers v4 + profiles, default unchanged; (2) own tokenization + batching + tests; (3) default switch + manifest bump + thresholds + docs/ADR; eval `--model` "preferably a separate step".

One constraint breaks the sketch as written: **a harrier profile must not be selectable before template-aware truncation exists.** Under the v4 `pipeline`, `--model harrier-270m` would embed noise for every note over 512 tokens (59 % of the owner's notes) — the exact Qwen3 0.164 failure the bake-off hit. granite-97m does not have this problem: CLS pooling is insensitive to a lost `[SEP]` (bake-off control: moved 0.004).

**Decision — four PRs, each independently mergeable and releasable:**

| PR | Content | Default | Corpus impact |
|---|---|---|---|
| 1 `Refs #98` | `@huggingface/transformers` 4.x migration; `ModelProfile` + closed registry with `bge-micro-v2` (transitional default) and `granite-97m`; `--model` on server and `index`; profile identity threaded into corpus/backend/store (no more constant reads); explicit manifest-mismatch reporting | bge-micro-v2 | none — identity unchanged, no re-index |
| 2 `Refs #98` | Provider-owned tokenization (template-aware truncation, declared padding side, mean/CLS/last-token pooling, query/document prefixes) for every profile; `embedQuery` / `embedDocuments` provider contract; batched document embeds through the queue; `harrier-270m` + `harrier-0.6b` join the registry; the EOS regression test | bge-micro-v2 | none forced (see Q7 note) |
| 3 `Refs #98` | `npm run eval -- --model`; eval refuses a corpus built by another profile; report records profile + similarities; threshold calibration statistics | bge-micro-v2 | none |
| 4 `Closes #98` | Default → `harrier-270m`; `bge-micro-v2` leaves the registry; `EMBED_CHAR_BUDGET` removed; manifest v2 (`embed_version` 2, new strategy, extended identity); per-profile recalibrated thresholds with numbers; ADR-0017; docs sweep; opsx verify → retro → archive | **harrier-270m** | every corpus rebuilds once |

Deviations from the sketch, to surface for ack: harrier profiles move from PR 1 to PR 2 (correctness, above); granite-97m ships in PR 1 so PR 1 has a real end-to-end deliverable (`--model granite-97m`); eval gets its own PR, sequenced before the switch because calibration depends on it. `bge-micro-v2` is a selectable profile in PRs 1–3 only (it has to be — it is the default there) and is removed in PR 4, leaving exactly the closed set from decision 2.

### Q2. Where does the profile registry live, and who sees what?

Options: (a) in `src/lib/obsidian/corpus/types.ts` next to today's constants; (b) a new `src/modules/semantic/model-profiles.ts`; (c) a new `src/lib/embedding/` package.

(a) would pull provider details (pooling, padding, prefixes) and tool concerns (thresholds) into the corpus library, which today is deliberately model-agnostic — it sees the model only through `EmbedFn`. (c) adds a package for one data file.

**Decision — (b).** `model-profiles.ts` in the semantic module owns the closed registry and the profile type. Consumers get narrow views:
- corpus library: a `CorpusIdentity` value (data) + a document-embed function — still no import from `src/modules/`;
- local provider: the tokenization/pooling fields;
- semantic tools: the profile's thresholds;
- `config.ts`: the key list (for `--model` choices) and the default key.

### Q3. What does the provider contract look like?

Today `EmbeddingProvider = { initialize(); embed(text) }`, used for queries by the retrieval path, and `EmbedFn = (text) => Promise<number[]>` for the indexer. Prefixes are asymmetric (query yes, document no), so a single `embed(text)` forces every caller to know about prefixes — or forces the provider to guess.

**Decision:**

```ts
interface EmbeddingProvider {
  readonly identity: EmbeddingIdentity;        // what produced the vectors → manifest
  initialize(): Promise<void>;
  embedQuery(text: string): Promise<number[]>;          // applies the query prefix
  embedDocuments(texts: string[]): Promise<number[][]>; // bare, ≤ maxBatchSize per call
  readonly maxBatchSize: number;
}
```

A remote API provider fits the same shape (most APIs already distinguish query vs document input types). `embed` is renamed to `embedQuery` everywhere — the rename is internal (no MCP surface) and the explicit name stops a caller from embedding a query without its instruction prefix, which would degrade harrier silently.

### Q4. How does the provider own tokenization?

The bake-off's working recipe, generalised so **every profile goes through one code path** (not just last-token ones):

1. Encode the content **without** special tokens (raw ids). For a query, the instruction prefix is encoded the same way and is never truncated.
2. Derive the special-token template from the tokenizer once at load: encode a sentinel with and without special tokens; the ids before/after the raw run are the prefix/suffix (`<bos>`/`<eos>` for Gemma-based harrier-270m, `<|endoftext|>` suffix for Qwen-based harrier-0.6b, `[CLS]`/`[SEP]` for granite/bge).
3. Truncate content ids to `max_tokens − |template prefix| − |template suffix| − |instruction|`.
4. Re-attach: `template prefix + instruction + content + template suffix`.
5. Pad the batch to its longest row on the side the tokenizer declares (`padding_side`), with its pad id; build the attention mask.
6. Run the model; pool by the profile's method — `mean` (masked), `cls` (first real token), `last_token` (last real token, which is the final column under left padding and the last unmasked column under right padding); L2-normalise.

Why one path for all: two paths (pipeline for encoders, own for decoders) means two truncation semantics in one registry and twice the tests. The cost is that bge-micro/granite vectors change for inputs over 512 tokens (the restored `[SEP]`) — see Q7.

Template: **derived** from the tokenizer (as the brief requires), not hardcoded. Each profile pins a Hugging Face **revision** (commit sha) so the tokenizer and weights a profile was verified against cannot change underneath it. The derived template per profile is asserted by a CI test against the real pinned tokenizers (Q11).

Also: a non-binding work bound — raw text is cut at `max_tokens × 32` characters before tokenizing, so a multi-megabyte note cannot blow up tokenizer memory. At 32 chars/token it can never bind before the token limit for real text (measured 1.6–2.9 chars/token); it is a bound on work, not a budget, and it is not `EMBED_CHAR_BUDGET` under another name.

### Q5. Where does batching happen, and how does the query lane keep priority?

Options: (a) cross-note windows in `reconcileCorpus` (collect inputs from several notes, sort globally by length, batch); (b) bounded note concurrency in reconcile + a coalescing queue; (c) per-note: reconcile hands one note's inputs (note text + blocks, avg 6.9) to one `embedDocuments` call; the queue splits them into length-bucketed batches.

(a) gives the best padding efficiency but restructures reconcile's per-note loop and its failure/abort contract (a failed batch would fail several notes at once; "stops at the next note boundary" becomes "at the next window"). (b) keeps per-note logic but makes progress/abort ordering nondeterministic.

Naive (c) has a trap: a note's own text is almost always its longest input (it contains every block), so one batch of `[note, b1..b6]` pads six short blocks to 512 tokens — measurably **slower** than batch 1. Hence bucketing.

**Decision — (c) with length buckets.** `embedDocuments` on the queue sorts a note's texts by length, greedily groups them into batches of ≤ 8 whose longest is ≤ 2× the shortest, enqueues each batch as one index-lane entry, and reassembles results in order. The query lane drains between batches, so a query waits for at most one in-flight batch (~0.5 s on harrier-270m, ~2 s on harrier-0.6b). Per-note failure containment and abort semantics stay exactly as they are. Cross-note batching (a) is the documented follow-up if the measured cold index misses "minutes"; PR 2's verify records batch-vs-unbatched timings on the owner's vault.

### Q6. What does the manifest record, and how is a mismatch reported?

Decision 4 says the manifest records what produced the vectors. Today it records `{embed_version, model_key, model_id, dims, strategy, created}`.

**Decision:** in PR 4 (with the one forced rebuild) the identity grows to `{embed_version, provider, model_key, model_id, revision, dtype, dims, pooling, max_tokens, strategy, created}` — every field that changes a stored vector. The query prefix is not in it (it does not change stored vectors). `strategy` is renamed (note text no longer char-cut) and `embed_version` goes 1 → 2. The identity value comes from the active provider (`provider.identity` + the corpus's own `embed_version`/`strategy`), so a remote provider writes its own.

Parsing tolerates the legacy shape (missing new fields), so the old identity can be *named* in the message instead of "manifest failed validation".

**Mismatch reporting** (lands in PR 1, when `--model` makes mismatch user-triggerable):
- server: one stderr warning per vault at startup naming stored vs active identity and that the corpus is being discarded and rebuilt in the background; the vault reports `indexing` (already surfaced as `semantic_status`) until the rebuild finishes;
- `index` CLI: a line per vault before its progress output saying the corpus is being rebuilt and why;
- eval: a hard error naming the `index --model` command to run (eval never rebuilds).

Auto-rebuild stays (it is how every user gets onto the new model without a manual step); the change is that it is no longer silent. No tool output shape changes.

Rejected: per-profile corpus directories (`.neuro-vault/corpus/<model_key>/`). Switching profiles would stop being destructive, but stale corpora accumulate on disk (the 56k-vector vault's corpus is 130 MB at 384 dims; ~220 MB at 640), the brief explicitly wants the old bge-micro folder invalidated rather than kept, and one profile per process makes switching rare. Known cost, documented: running the server and `index` with different `--model` values on the same vault makes them rebuild against each other — the new warnings make that visible.

### Q7. When does `EMBED_CHAR_BUDGET` go, and what about vectors that change mid-sequence?

The char cut changes note vectors for every profile, so removing it is a corpus-identity change → it belongs in PR 4 with the one `embed_version` bump.

PR 2's own tokenization also changes bge-micro/granite vectors, but only for inputs over 512 tokens and only by one token (the restored `[SEP]`, which the pipeline dropped). Bumping `embed_version` there would force a full rebuild in PR 2 and another in PR 4. **Decision:** no bump in PR 2; the drift is stated in PR 2's description and measured in its verify (cosine between old and new vectors for a few capped notes). Anyone on a PR 2/3 build gets a clean rebuild at PR 4 regardless.

### Q8. Thresholds: one set, or per profile?

Encoder-CLS (granite) and decoder-last-token (harrier) models have very different similarity distributions; one threshold set cannot be right for both, and `--model granite-97m` must work end-to-end.

**Decision: thresholds are profile data.** Each profile carries `similarity: { quick, deep, fallback, expansionFloor, similarNotes, duplicates }`; the semantic module reads the active profile's, and tool descriptions interpolate the active values (they already interpolate the constants). In PRs 1–3 every profile carries today's bge-micro values (granite included — knowingly mis-scaled until PR 4).

**Calibration procedure (PR 4)** — "thresholds keep doing what they did, on the new scale":
1. Before any harrier index touches the owner's vault, capture the bge-micro baseline from the existing corpus with PR 3's eval statistics: for each threshold, its pass rate over the population it filters (query↔note similarities of golden queries' ranked candidates for quick/deep/fallback; seed↔neighbour similarities for `expansion_floor`; note↔note top-k neighbour similarities for `similarNotes` and the pair distribution for `duplicates`). The single corpus directory means this baseline is gone once the vault is re-indexed — capture first.
2. For each profile, index the vault, compute the same distributions, and set each threshold to the quantile that reproduces the baseline pass rate.
3. Guard on the golden set: at deep effort, the recalibrated `deep` threshold must not drop any first-relevant hit that threshold 0 finds; `quick` must keep hit@3 within one query of threshold 0.
4. Record every number (baseline pass rate, new value per profile, guard results) in ADR-0017 and `docs/architecture/retrieval-policy.md`.

### Q9. What does eval `--model` do?

**Decision:** `--model <key>` (default: the registry default) builds the embedder from the profile and **validates the vault corpus manifest against it** before embedding anything — a mismatch fails naming `neuro-vault-mcp index --vault <path> --model <key>`. Today eval would happily cosine a 640-dim query against a 384-dim corpus. The report records `model_key` (+ the full identity), and each `per_query` entry carries the similarity of every ranked path plus the best similarity of any relevant note regardless of rank — the raw material for Q8. A `--stats` flag adds the distribution summaries Q8 needs (quantiles of the four populations) to the report. Reproducing the bake-off becomes: for each profile, `index --model X` then `eval --model X` — destructive to the vault's corpus by construction (Q6), documented in `eval/README.md`.

### Q10. Where are effort-profile thresholds wired in eval?

`eval/pipelines.ts` restates effort-profile numbers as literals (`EVAL_CONFIG`). With thresholds moving into model profiles, eval's `expansion_floor` must follow the active profile or `fused` stops being the production pipeline. **Decision:** in PR 4, `EVAL_CONFIG.expansion_floor` reads the active profile's value (semantic thresholds stay 0 in eval by design).

### Q11. How do we prove the EOS bug cannot come back?

- Unit (DI, no download): a fake tokenizer whose encoding of a long text exceeds `max_tokens`; assert every row ends with the template suffix (`<eos>`), has exactly `max_tokens` real tokens, and pads on the declared side; last-token pooling picks the EOS column under both left and right padding; CLS pooling picks the first real token under left padding; the query prefix survives truncation. This is the test that would have caught "truncated note without EOS".
- CI (real tokenizers, no weights): a test gated behind an env flag, run by a dedicated CI job with a Hugging Face cache, loads each profile's tokenizer at its pinned revision and asserts the derived template, padding side, and that a > 512-token input encodes to exactly `max_tokens` ids ending in the template suffix. Source-level tests cannot observe what a real tokenizer config does, so this property needs a CI step rather than a one-time manual check.
- End-to-end: the acceptance eval numbers (UA MRR ≥ 0.6, EN MRR ≥ 0.8 for harrier-270m) are the integration proof.

### Q12. ADR: new or amend 0006?

ADR-0006 is already superseded (by 0013/0014), and the decision here — a closed set of verified profiles, a provider seam, provider-owned tokenization, per-profile thresholds — is new. **Decision: new ADR-0017**, written in PR 4 with the calibrated numbers; ADR-0013 gets no edit (its "embed_version + full rebuild is the migration lever, including a change of model" is exactly what PR 4 uses).

## Acceptance (from the brief)

- `npm test && npm run lint && npm run typecheck && npm run build` pass on every PR.
- `neuro-vault-mcp index --vault <owner vault>` with the default profile indexes in minutes (bake-off: 6–11 min for ~6k vectors); `npm run eval -- --pipeline semantic` gives UA MRR ≥ 0.6 and EN MRR ≥ 0.8.
- `--model granite-97m` works end-to-end; an unknown `--model` is rejected listing the allowed keys.
- Docs: `docs/architecture/embedding-pipeline.md`, ADR-0017, full `docs/` sweep (guide included).

## Open items carried into design

- transformers.js v4 API specifics (tokenizer/model loading, `revision`, input names for Gemma-3/Qwen3/ModernBERT exports, cache location) — confirmed by a read-only API survey before the plan's snippets are written; anything the survey leaves uncertain becomes PR 1's first spike task.
- Throughput of per-note bucketed batching vs the bake-off's globally sorted batches — measured in PR 2's verify.

## Post-survey corrections (transformers.js 4.3.1 API survey, read-only, same session)

- **harrier-0.6b pads right, not left.** Its Qwen tokenizer config declares no `padding_side`, so transformers.js defaults to right; the "Qwen pads left" fact in the bake-off belongs to Qwen3-Embedding-0.6B. Nothing in the design depended on the side — the provider follows the tokenizer's declaration — but the CI check now pins "right" for all three profiles. harrier-0.6b's pad id (151643) equals its template suffix id, so last-token pooling must locate the last real token from the attention mask, never from ids.
- **Templates confirmed from each pinned `tokenizer.json` post-processor**: harrier-270m `[2] … [1]`, harrier-0.6b `… [151643]`, granite-97m `[179934] … [179938]`. `eos_token_id` is not the suffix for harrier-0.6b (151645 vs 151643) — derivation by sentinel diff is required, not a convenience.
- **The v4 pipeline cannot serve even PR 1's bge-micro path**: `model_max_length` is a getter (today's cap-by-assignment hack has nothing to assign to), `last_token` pooling ignores the mask, and the EOS loss is confirmed in source. PR 1 therefore already calls tokenizer + `AutoModel` directly, with v2-equivalent truncation and mask-aware mean/CLS pooling; PR 2 replaces only the encoding step.
- **Harrier ONNX outputs unverified**: the model cards read a pooled `sentence_embedding`; whether token states are also exported is unknown without downloading. Spike 1.1 decides per profile; own pooling over token states is preferred where available.
- **Runtime environment**: v4's default model cache sits inside the package dir (moves with the rename; purgeable under `npx`) → a stable `XDG_CACHE_HOME/neuro-vault/models` cache, set globally because the tokenizer file probe ignores per-call options; `env.logLevel` = error to keep stdout clean; `sharp` raises the Node floor to 20.9.0; `onnxruntime-node`'s postinstall pulls CUDA binaries on Linux x64 unless `ONNXRUNTIME_NODE_INSTALL=skip`.

