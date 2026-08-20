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
- An empty corpus throws inside the loader. Its caller — `VaultRegistry.create` — catches that throw and records `semanticAvailable: false` on the affected `VaultEntry`. Startup no longer fails on a single empty corpus; the failure surfaces at semantic-tool-call time as `SEMANTIC_INDEX_NOT_FOUND` (when an explicit `vault:` targets that vault) or as a `skipped_vaults` entry in fan-out responses. The invariant _inside_ the loader is unchanged — it still throws on an empty result; only the caller semantics changed.

## Boundaries

- The loader does not read note content (`.md`), only the embedding index. Note bodies are read on demand by tools.
- The loader does not watch for changes; staleness is handled by the [Refresh](#refresh) wrapper, not by the loader itself.
- The loader does not generate embeddings. That is the embedding pipeline's job, used at query time only.

## Refresh

The loader does not watch for changes, but the in-memory corpus is wrapped in a `SmartConnectionsCorpusIndex` (`src/lib/obsidian/smart-connections-corpus-index.ts`). Every semantic tool handler calls `corpus.snapshot()` to obtain the current `{ sources, basenameIndex }` pair before reading. `snapshot()` compares the `(max mtime, file count)` of `.smart-env/multi/*.ajson` against the values cached at last load and reloads the whole corpus when they differ; the `basenameIndex` is rebuilt at the same time, atomically with the sources swap. It then returns the stable `{ sources, basenameIndex }` pair — subsequent internal swaps do not mutate the caller's reference.

Reload failure throws — we never silently serve a snapshot known to be inconsistent with disk. Tool handlers wrap the throw via the existing `wrapDependencyError` helper, so callers receive `ToolHandlerError('DEPENDENCY_ERROR', ...)`.

Concurrent `snapshot()` calls share a single in-flight reload via an internal latch; the second caller awaits the first and returns once the swap completes. The mtime+file-count signature is captured BEFORE the reload begins, so any writes that land during the reload trigger another reload on the next call (eventually consistent, no silent staleness).

Mirrors the pattern in `WikilinkGraphIndex.ensureFresh()` (`src/lib/obsidian/wikilink-graph.ts`).

## Stale paths

Refresh keeps the corpus consistent with the `.ajson` files, not with the vault. Between a note's deletion on disk and the plugin's next index write, the corpus still names it — and `null` tombstones mean a path can outlive its file even after a reload. So a corpus-derived path is a claim about the index, never a promise about the filesystem.

Every tool that returns corpus-derived paths therefore filters them at the handler seam, through `IVaultEntry.filterExisting` (`src/lib/obsidian/existing-paths.ts`). It takes vault-relative paths and returns those that still resolve under that vault's root: input de-duplicated, each path checked independently, a missing file reported as absent rather than raised. Current consumers:

| Tool | What it filters |
| --- | --- |
| `search_notes` | semantic seeds and their flattened expansion targets, against one set. Lexical-only matches skip the check — reading them from disk this request already proved they exist. |
| `find_duplicates` | both members of every pair; a pair with one missing member is dropped whole. |
| `get_similar_notes` | every candidate, semantic or forward-linked, after `exclude_folders` has been applied. |

One implementation, so no consumer can disagree about what "exists" means or skip the check by forgetting it, and a new corpus-reading tool inherits the guarantee from the entry it already holds. The filter is built per vault by `existingPathFilterFactory` in `IVaultEntryDeps` — see [vault-registry](vault-registry.md) — which is also what makes it substitutable in tests without provisioning files.

Two things this deliberately is not. The corpus itself is not made staleness-aware: it stays read-only and unwatched, as [ADR-0006](../adr/0006-smart-connections-corpus.md) decided, and the filter compensates at the edge rather than moving the problem upstream. And the check does not live in the retrieval policy layer, which stays free of disk I/O — handlers call it, policy does not.
