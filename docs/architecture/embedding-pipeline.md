# Embedding Pipeline

How the server turns a query string into a vector that can be compared against the corpus.

## What it is

`src/embedding-service.ts` wraps a `@xenova/transformers` `pipeline('feature-extraction', modelKey)` call behind the `EmbeddingProvider` interface (`{ initialize(), embed(text) }`). The default model is `TaylorAI/bge-micro-v2`, chosen because Smart Connections uses the same model — query and corpus embeddings live in the same vector space without any conversion.

## Why it exists

Tool handlers should not import `@xenova/transformers` directly. Wrapping the pipeline gives:

- A narrow interface that is trivial to mock in tests.
- A single place to handle the model's pluggable output shape (regular array, typed array, or `{ data: Float32Array }`).
- Lazy initialization that is safe under concurrent calls.

## Lazy initialization

The model is ~40 MB and takes seconds to load on first run. The service does not block server startup on the load:

```
new EmbeddingService({ modelKey })
  │
  ├─ start: pipeline = undefined, initialization = null
  │
  ├─ initialize() (called eagerly by server, fire-and-forget)
  │     └─ getPipeline() → caches the singleton initialization promise
  │
  └─ embed(text)
        └─ getPipeline() → awaits the same promise
```

Two concurrent `embed` calls during startup share the same `initialization` promise — only one model load happens. If the load fails, the cached promise is cleared so the next call retries instead of inheriting the failure forever.

The server fires `initialize()` after `connect()` and silently swallows the rejection. If pre-warm fails, the first real `embed` call retries; users see the slow first search instead of a startup failure.

## Output normalization

Different transformers versions return different shapes:

- Plain `number[]`
- Typed array (`Float32Array`)
- Wrapped object with `data: Float32Array`

`normalizeEmbedding` handles all three and rejects anything else. Each value is coerced to a finite `number`; non-numeric or non-finite values throw with the index they appeared at.

## Invariants

- `embed` is called with mean-pooled, normalized output (`pooling: 'mean', normalize: true`). Every returned vector is unit-length, which keeps cosine similarity numerically stable.
- The text is trimmed before embedding; empty / whitespace-only input throws before reaching the model.
- The output dimension must match the corpus dimension. The search engine does the per-call check; the embedding service does not enforce it (it does not know the corpus).

## Boundaries

- The service does not store or cache embeddings. Caching would be wrong: queries are short-lived and the corpus already holds its own pre-computed embeddings.
- The service does not pick the model. The caller passes `modelKey`, and the caller is responsible for matching it to whatever Smart Connections used.
