# Embedding Pipeline

How the server turns a query string or a document into a vector that can be compared against the corpus.

## What it is

`src/modules/semantic/embedding-service.ts` is the local, in-process implementation of the `EmbeddingProvider` interface (`src/modules/semantic/types.ts`). It is built from one `ModelProfile` — a record in [`model-profiles.ts`](../../src/modules/semantic/model-profiles.ts) that holds everything model-specific: the Hugging Face repo, the pinned revision, `dtype`, output dimension, pooling method, query/document prefixes, the token window (`maxTokens`) and the profile's default similarity thresholds (see [`retrieval-policy.md`](./retrieval-policy.md#calibration)). The decision behind the registry is [ADR-0017](../adr/0017-embedding-model-profiles.md).

## Profiles

The registry is closed: no input ever names a repository directly, so a profile joins it only after it has been measured on the retrieval eval and verified against the pinned `@huggingface/transformers` version. `--model <key>` picks one per process (see [`cli-startup.md`](./cli-startup.md)); `harrier-270m` is the default.

| Key | Role | Pooling | Dims | Query prefix | Download | Pinned revision |
| --- | --- | --- | --- | --- | --- | --- |
| `harrier-270m` (default) | multilingual, balanced | last token | 640 | retrieval instruction | ≈ 344 MB | `d59c919` |
| `granite-97m` | lite multilingual | CLS | 384 | none | ≈ 98 MB | `536a9f2` |
| `harrier-0.6b` | highest quality | last token | 1024 | retrieval instruction | ≈ 706 MB | `e4daffa` |

All three run quantized (`dtype: 'q8'`) with a 512-token window and no document prefix. Each `revision` is the exact repository commit the profile was verified against, never a branch. Downloaded weights live in the model cache (see step 1 below), so a profile is fetched once per machine.

To embed, the service:

1. Loads the profile's tokenizer and model through [`local-model-loader.ts`](../../src/modules/semantic/local-model-loader.ts), which drives `@huggingface/transformers` (pinned to exactly 4.3.1) directly: `AutoTokenizer` and `AutoModel` at the profile's pinned `revision`, `dtype: 'q8'`, CPU. The loader sets a global cache directory — `$XDG_CACHE_HOME/neuro-vault/models` when `XDG_CACHE_HOME` is an absolute path (a relative one is ignored, as the XDG spec requires), else `~/.cache/neuro-vault/models` — and the library's log level to `error`, which keeps the library's own logging off stdout, the channel the MCP transport owns.
2. Turns each trimmed text into a model input row made of exactly the tokens the model was trained on — special-token template included, cut to `maxTokens` without losing the template's end (see [Tokenisation](#tokenisation)).
3. Pads the rows of a call into one batch, runs a single forward pass, pools the output by the attention mask ([`pooling.ts`](../../src/modules/semantic/pooling.ts)) and normalizes each vector to unit length.

The service also exposes `identity` (`provider`, `model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens`) — everything that determines the vectors it produces. The corpus records that identity in its manifest, adds its own `embed_version` and `strategy`, and compares every field on startup; see [`own-corpus.md`](./own-corpus.md) for what a mismatch does (that model's directory is discarded and rebuilt — each model keeps its own).

## Where the model lives

No caller constructs a provider directly. `createEmbeddingProvider({ profile, shared, cliPath, … })` (`src/modules/semantic/provider-factory.ts`) is the one place a provider is chosen. The server, `index` and the daemon's `embed` service all call it ([ADR-0018](../adr/0018-shared-services-daemon.md)):

| Caller | `shared` | What it gets |
| --- | --- | --- |
| Server, `index` (default) | `true` | `DaemonEmbeddingProvider`, a facade onto the shared daemon; the model is loaded there, once per machine per build and profile |
| Server, `index` with `--no-shared` | `false` | `EmbeddingService` in this process, as before the daemon existed |
| The daemon's `embed` service | always `false` | `EmbeddingService`, built by `daemonProviderFor` (`src/cli-daemon.ts`); a facade there would connect to the daemon itself |

The facade has the same contract as `EmbeddingService` and the same `identity`, computed locally from the profile, so a corpus built through one is served by the other without a rebuild. Its `maxBatchSize` is the daemon's, reported by `embed.initialize`. When the daemon cannot be found or started, it falls back once per process to an in-process `EmbeddingService`. The connection, the spawn, the timeouts and the fallback rules are in [`shared-daemon.md`](./shared-daemon.md#the-session-side-facade). Everything below this section describes `EmbeddingService` itself, wherever it runs.

## Why it exists

Tool handlers and the indexer should not import `@huggingface/transformers` or know which model is running. Wrapping tokenizer + model behind the provider gives:

- A narrow interface that is trivial to mock in tests (the loader is injectable, so tests never touch the network or onnxruntime).
- One place for everything that differs between models — the profile — so a new model is a registry entry, not a change in the service, the corpus, or the tools.
- Lazy initialization that is safe under concurrent calls.
- A process with semantics off never loads onnxruntime: the library is imported only when the loader first runs.

## Lazy initialization

The model takes seconds to load on first run (and downloads first, if it is not cached yet). The service does not block server startup on the load:

```
new EmbeddingService({ profile })
  │
  ├─ start: model = undefined, initialization = null
  │
  ├─ initialize() (called eagerly by server, fire-and-forget)
  │     └─ getLoaded() → caches the singleton initialization promise
  │
  └─ embedQuery(text) / embedDocuments(texts)
        └─ getLoaded() → awaits the same promise
```

Two concurrent embed calls during startup share the same `initialization` promise — only one model load happens. If the load fails, the cached promise is cleared so the next call retries instead of inheriting the failure forever.

The server fires `initialize()` after `connect()` and silently swallows the rejection. If pre-warm fails, the first real embed call retries; users see the slow first search instead of a startup failure.

When the model finishes loading, the service derives the special-token template from the tokenizer once and keeps it, with the tokenizer's pad id and padding side, alongside the model.

## Tokenisation

`EmbeddingService` owns tokenisation for every profile. Each input becomes one model row in six steps ([`tokenization.ts`](../../src/modules/semantic/tokenization.ts)):

1. **Raw ids.** The profile's prefix followed by the trimmed content is encoded **without** special tokens. Encoding prefix and content together tokenises their boundary the way the model was trained, and since the prefix comes first a cut only ever removes content. The content is first clipped to `maxTokens × 32` characters (`CHARS_PER_TOKEN_WORK_BOUND`): a bound on tokenizer work for multi-megabyte notes, not a budget — prose runs 1.6–2.9 characters per token, so the token limit binds first. Only text that tokenises to almost nothing — long whitespace runs, which BERT drops and BPE merges — can reach this bound before the token limit.
2. **Template, derived by sentinel diff.** At load the service encodes a one-character sentinel with and without special tokens and reads the template off the difference: what the post-processor puts before the sentinel is the prefix, what it puts after is the suffix. The template is read off the tokenizer rather than trusted from its config because the two can disagree — harrier-0.6b declares an `eos_token_id` of 151645 while its post-processor appends 151643. If the sentinel's raw ids cannot be found inside the full encoding, the load throws and names both encodings.
3. **Budget.** `maxTokens − |template prefix| − |template suffix|` ids are left for text; a window with no room for even one token throws.
4. **Re-attach.** The raw ids are cut to the budget, then the template prefix and suffix are put back around them. A row is therefore never longer than `maxTokens`, is exactly that long for over-long content, and always ends in the real template suffix — even when the content itself contains a literal end token.
5. **Pad on the declared side.** The rows of a call are padded to the longest with the tokenizer's pad id, on the side the tokenizer declares (`padding_side`; right when it is silent). The attention mask marks real tokens with 1.
6. **Pool by the mask.** See [Pooling](#pooling).

**Why not the library's own encode.** `@huggingface/transformers` truncates **after** the post-processor has run, so an over-long input loses its trailing special token. A mean- or CLS-pooling model shrugs that off; a last-token model (harrier) pools exactly that token, and would silently embed an arbitrary mid-sentence position instead. Cutting first and re-attaching the template gives every profile one truncation semantics. It also keeps an over-long block from crashing inside ONNX — a tokenizer can declare no real window (a `model_max_length` of 1e15, say), so the profile's `maxTokens` is the only limit. An input that fits the window encodes exactly as the library would encode it.

The derived template and padding side of every profile at its pinned revision are checked against the real tokenizer by the `profile-tokenizers` job in [`ci.yml`](../../.github/workflows/ci.yml) (`test/integration/profile-tokenizers.test.ts`, skipped unless `NEURO_VAULT_HF_TESTS=1`): a mis-pinned revision fails CI, not retrieval.

## Queries and documents

The provider has two entry points because the two inputs are not the same kind of text:

- `embedQuery(text)` applies the profile's `queryPrefix` and embeds one text. harrier's prefix is its retrieval instruction (`Instruct: Given a web search query, retrieve relevant passages that answer the query`, a newline, `Query: `); `granite-97m` has none.
- `embedDocuments(texts)` applies the profile's `documentPrefix` (empty for every shipped profile) and embeds at most `maxBatchSize` (8) texts in one call, returning vectors in input order. A larger batch is rejected. So is a blank text, naming its index, **before** any model call — embedding the bare template would return a plausible-looking vector for nothing. An empty list returns `[]`.

**No caller ever adds a prefix.** The prefix is part of what makes a vector a query vector or a document vector, so it lives with the profile and is applied in this one place; the retrieval path, the corpus indexer and the tests all hand the provider plain text.

## Batching

A call is one forward pass: its rows are padded to the longest and run together. That is a throughput win for the indexer, which hands every input of one note (the note-level text plus its blocks) to `embedDocuments` in a single call. Padding costs compute, though, and a note's own text contains all its blocks, so it is nearly always its longest input — batched with them, it would pad every block to its length. [`embed-queue.ts`](../../src/modules/semantic/embed-queue.ts) therefore splits a call into **length buckets** before it reaches the provider: texts are sorted shortest-first and grouped into batches of at most `maxBatchSize` whose longest text is at most twice the shortest (by character count). Each bucket is one queue entry and one forward pass, and the vectors are put back in the caller's order. The queue also keeps live queries ahead of indexing batches and isolates one call's failure from another's — see [`semantic-backend.md`](./semantic-backend.md#the-shared-embed-queue).

## Pooling

The model returns either per-token states (`[batch, seq, hidden]`) or a vector already pooled inside the graph (`[batch, hidden]`). The loader prefers token states (`last_hidden_state`, or its alias `token_embeddings`) and falls back to a pooled `sentence_embedding`. It fails at load, naming the profile, when the export has neither, lacks the `input_ids` / `attention_mask` inputs, or has a position window smaller than the profile's `maxTokens` — and it disposes the model it just loaded before rejecting. The harrier exports ship only the pooled output; since that pooling happens inside the graph, the mask-driven code below cannot correct it, and it is right only under right padding, which every pinned tokenizer uses (asserted by the CI tokenizer check). `poolAndNormalize` turns the output into one unit-length vector per input row.

The contract: **positions come from the attention mask, never from token ids.** A tokenizer can pad with the very id its template appends, so only the mask can tell the last real token from padding. `mean` averages the real positions, `cls` takes the first real position, `last_token` takes the last real position. A row with no real tokens, a mask whose length disagrees with the output's sequence length, a non-finite value or a zero vector throws rather than producing a plausible-looking result.

## Invariants

- Every returned vector is unit-length, which keeps cosine similarity numerically stable, and is pooled the way its profile declares (`mean`, `cls` or `last_token`).
- Text is trimmed before embedding; empty / whitespace-only input throws before reaching the model (for a document batch, naming the offending index).
- A row is never longer than `maxTokens` and always ends in the tokenizer's real template suffix: truncation removes content, never the special tokens a last-token model pools from.
- No prefix is ever added by a caller; the provider applies the profile's `queryPrefix` / `documentPrefix` and nothing else does.
- One provider call is one forward pass over at most `maxBatchSize` rows.
- The output dimension must match the corpus dimension. The corpus store checks every vector it writes against the identity's `dims`; the search engine does the per-call check at query time.

## Boundaries

- The service does not store or cache embeddings. Caching would be wrong: queries are short-lived and the corpus already holds its own pre-computed embeddings.
- `--model` picks the profile; the service never has a default of its own. The caller passes a `ModelProfile`, and the corpus — not the caller — is responsible for noticing that the stored vectors came from another model or configuration (via `identity`), so vector spaces are never mixed: another profile reads and writes its own directory in the vault, and only an identity change within one model (a new revision, `embed_version`, …) rebuilds that model's directory. See [`own-corpus.md`](./own-corpus.md).
