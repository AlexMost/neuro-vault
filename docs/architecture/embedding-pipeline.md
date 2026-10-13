# Embedding Pipeline

How the server turns a query string into a vector that can be compared against the corpus.

## What it is

`src/modules/semantic/embedding-service.ts` is the local, in-process implementation of the `EmbeddingProvider` interface (`src/modules/semantic/types.ts`). It is built from one `ModelProfile` — a record in [`model-profiles.ts`](../../src/modules/semantic/model-profiles.ts) that holds everything model-specific: the Hugging Face repo, the pinned revision, `dtype`, output dimension, pooling method, query/document prefixes and the token window (`maxTokens`). The registry is closed — `bge-micro-v2` (the default, mean pooling, 384 dims, ≈ 17 MB) and `granite-97m` (a lite multilingual model, CLS pooling, 384 dims, ≈ 98 MB) — and `--model <key>` picks one per process (see [`cli-startup.md`](./cli-startup.md)).

To embed, the service:

1. Loads the profile's tokenizer and model through [`local-model-loader.ts`](../../src/modules/semantic/local-model-loader.ts), which drives `@huggingface/transformers` (pinned to exactly 4.3.1) directly: `AutoTokenizer` and `AutoModel` at the profile's pinned `revision`, `dtype: 'q8'`, CPU. The loader sets a global cache directory — `$XDG_CACHE_HOME/neuro-vault/models` when `XDG_CACHE_HOME` is an absolute path (a relative one is ignored, as the XDG spec requires), else `~/.cache/neuro-vault/models` — and the library's log level to `error`, which keeps the library's own logging off stdout, the channel the MCP transport owns.
2. Encodes the trimmed text **with** special tokens, then cuts the id sequence to `maxTokens`. This is the encoding the transformers.js 2 pipeline the server used before produced, kept on purpose so corpora already built with `bge-micro-v2` stay valid (no `embed_version` bump).
3. Pools the model's output by the attention mask ([`pooling.ts`](../../src/modules/semantic/pooling.ts)) and normalizes to unit length.

The service also exposes `identity` (`provider`, `model_key`, `model_id`, `revision`, `dtype`, `dims`, `pooling`, `max_tokens`) — what produced these vectors. The corpus records a five-field projection of it (`model_key`, `model_id`, `dims`, plus its own `embed_version` and `strategy`) and compares only those; see [`own-corpus.md`](./own-corpus.md) for what a mismatch does (discard and rebuild). `revision`, `dtype`, `pooling` and `max_tokens` are reported but not yet part of that comparison.

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
  │     └─ getModel() → caches the singleton initialization promise
  │
  └─ embed(text)
        └─ getModel() → awaits the same promise
```

Two concurrent `embed` calls during startup share the same `initialization` promise — only one model load happens. If the load fails, the cached promise is cleared so the next call retries instead of inheriting the failure forever.

The server fires `initialize()` after `connect()` and silently swallows the rejection. If pre-warm fails, the first real `embed` call retries; users see the slow first search instead of a startup failure.

## Pooling

The model returns either per-token states (`[batch, seq, hidden]`) or a vector already pooled inside the graph (`[batch, hidden]`); the loader picks whichever the export provides and fails at load, naming the profile, when it has neither. `poolAndNormalize` turns that into one unit-length vector per input row.

The contract: **positions come from the attention mask, never from token ids.** A tokenizer can pad with the very id its template appends, so only the mask can tell the last real token from padding. `mean` averages the real positions, `cls` takes the first real position, `last_token` takes the last real position. A row with no real tokens, a non-finite value or a zero vector throws rather than producing a plausible-looking result.

## Invariants

- Every returned vector is unit-length, which keeps cosine similarity numerically stable.
- The text is trimmed before embedding; empty / whitespace-only input throws before reaching the model.
- An input longer than `maxTokens` is cut at `maxTokens` ids after encoding. The cut drops the trailing special token of an over-long input, which mean and CLS pooling tolerate; it is also what keeps an over-long block from crashing inside ONNX.
- The output dimension must match the corpus dimension. The corpus store checks every vector it writes against the identity's `dims`; the search engine does the per-call check at query time.

## Boundaries

- The service does not store or cache embeddings. Caching would be wrong: queries are short-lived and the corpus already holds its own pre-computed embeddings.
- `--model` picks the profile; the service never has a default of its own. The caller passes a `ModelProfile`, and the corpus — not the caller — is responsible for noticing that the stored vectors came from another model (via `identity`), so a vault indexed with a different model is rebuilt instead of mixing vector spaces. See [`own-corpus.md`](./own-corpus.md).
