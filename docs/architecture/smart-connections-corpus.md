# Smart Connections Corpus

How the server reads Smart Connections embedding data into memory and what guarantees it provides about that data.

## What it is

`src/smart-connections-loader.ts` reads `<vault>/.smart-env/multi/*.ajson` files at startup, parses them, and builds a `Map<string, SmartSource>` keyed by vault-relative POSIX path. Each `SmartSource` carries the note's embedding vector and a list of `SmartBlock`s (heading, line range, embedding).

## Why it exists

Smart Connections (an Obsidian plugin) maintains embeddings for every note and every block in a vault. Reusing this index means we get embeddings for free — no re-indexing, no API keys, no background process. The trade-off is that the format is plugin-internal: AJSON files are concatenated `"key": { ... },` entries with last-write-wins semantics, plus support for `null` values to mark deletions. We parse this format directly because doing so is faster than asking Smart Connections to re-export.

## How it interacts

```
loadSmartConnectionsCorpus(smartEnvPath, modelKey)
  │
  ├─ readdir → list of *.ajson files (sorted, deterministic order)
  │
  └─ for each file:
      parseAjsonContent → AjsonEntry[]
        │
        ├─ smart_blocks:<key> entries → blockEmbeddings map
        └─ smart_sources:<key> entries → SmartSource (with attached blocks)

→ Map<path, SmartSource>
```

Once built, the map is read-only: no one mutates it. The map is passed by reference into tool handlers; iteration cost is `O(n)` over all sources for every search, but `n` is small enough (single-digit thousands typical) that the simple linear scan is faster than maintaining an index.

## Format quirks

- AJSON files lack proper bracketing, so the parser tracks brace depth manually rather than wrapping in `[]` and using `JSON.parse`.
- A `null` value on a key means the entry is tombstoned — skip it.
- Embedding entries live under `value.embeddings[<model-key-suffix>].vec`. The model key suffix is matched by substring (`includes`) because Smart Connections appends a hash.
- Blocks are stored as separate `smart_blocks:<source>#<heading>` entries; the loader joins them back to their parent `SmartSource` after the file is fully parsed.

## Invariants

- All sources in the resulting map have non-empty embeddings of the same dimension. Mixed dimensions throw at load time — better to fail loudly than silently produce nonsense similarities.
- Paths are normalized to vault-relative POSIX form (`Folder/note.md`). Absolute paths, Windows paths, and `..` segments are rejected.
- An empty corpus throws. The server cannot meaningfully serve an empty vault.

## Boundaries

- The loader does not read note content (`.md`), only the embedding index. Note bodies are read on demand by tools.
- The loader does not watch for changes. The corpus is loaded once at startup. Restart the server to pick up new embeddings.
- The loader does not generate embeddings. That is the embedding pipeline's job, used at query time only.
