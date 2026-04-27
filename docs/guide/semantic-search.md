# Semantic Search

Find notes by meaning, not by filename. The server embeds your query with `TaylorAI/bge-micro-v2`, runs cosine similarity against the Smart Connections corpus loaded into memory at startup, and returns ranked results — optionally with block-level matches and semantic expansion.

For internals (the four-step pipeline, fallback, expansion math), see [`docs/architecture/retrieval-policy.md`](../architecture/retrieval-policy.md).

## `search_notes`

```typescript
search_notes({
  query: string | string[],     // 1-4 word keywords; array of 1-8 for synonyms / translations
  mode?: 'quick' | 'deep',      // default: 'quick'
  limit?: number,               // default: 3 (quick) / 8 (deep)
  threshold?: number,           // default: 0.5 (quick) / 0.35 (deep), 0–1
})
```

### Modes

| Mode    | Use when                          | `limit` default | `threshold` default | Block search                            | Expansion       |
| ------- | --------------------------------- | --------------- | ------------------- | --------------------------------------- | --------------- |
| `quick` | Specific question, need 1–2 notes | 3               | 0.50                | scoped to matched notes, threshold = 0, cap = 5 | off             |
| `deep`  | Broad topic, need an overview     | 8               | 0.35                | across whole vault, threshold = mode, limit = mode | on, top-3 |

`limit` widens or narrows the `results` array but does not affect `blockResults` (which is always capped by mode-specific logic). `expansion` is no longer a tool parameter — it is fixed by mode.

### Output shape — `quick`

```json
{
  "results": [
    { "path": "Projects/neuro-vault.md", "similarity": 0.81 },
    { "path": "Notes/embeddings.md",     "similarity": 0.74 }
  ],
  "blockResults": [
    {
      "path": "Projects/neuro-vault.md",
      "heading": "## Architecture",
      "lines": [42, 58],
      "similarity": 0.79
    }
  ]
}
```

### Output shape — `deep`

Same shape as quick, but `results` can have up to `limit` entries (default 8) and `blockResults` is searched across the whole vault rather than scoped to matched notes.

### Output shape — multi-query (`query` is an array)

```json
{
  "results": [
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.82,
      "matched_queries": ["embeddings", "векторний пошук"]
    },
    {
      "path": "Projects/neuro-vault.md",
      "similarity": 0.76,
      "matched_queries": ["embeddings"]
    }
  ],
  "blockResults": [],
  "truncated": false
}
```

- `matched_queries` lists which of your queries surfaced this path. If only one of your synonyms hit, that's a useful signal.
- `truncated: true` means more candidates were merged than fit the cap (`min(limit × N, 50)`, where `N` is the unique-query count after dedupe). The user-supplied `limit` controls the merged-output cap; per-query retrieval always uses the mode default for its own top-K.

### Tuning threshold

- **0.50** (quick default) — confident matches only. Most matches are visibly relevant; misses are common.
- **0.35** (deep default) — broader net. Some weaker matches mixed in; more recall.
- **0.30** — automatic fallback floor used when initial results are empty. Useful manual setting when you really do not want a "nothing found" answer.
- **0.60+** — strict. Use when getting too much noise. Below ~0.7 weakens fast in this embedding model.

### When to call multiple times

You usually shouldn't. Pass an array `query` instead — it batch-embeds and returns one merged ranked list with `matched_queries`. Reasons to call more than once:

- The vault is multilingual and you have evidence of which languages are present from earlier reads — include translations in the same `query` array.
- The first call returned nothing and lowering threshold did not help — try a different keyword set.

## `get_similar_notes`

Find notes similar to a given note path. Use this **after** `search_notes` finds a relevant note — it discovers related content without needing a text query.

```typescript
get_similar_notes({
  path: string,       // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
  limit?: number,     // default: 10
  threshold?: number, // default: 0.5
})
```

Returns the same `[{ path, similarity }, ...]` shape as `search_notes` `results`.

## `find_duplicates`

Find note pairs with high embedding similarity. Useful for vault maintenance — identifies notes that cover the same topic and could be merged.

```typescript
find_duplicates({
  threshold?: number, // default: 0.9
})
```

Returns `[{ note_a, note_b, similarity }, ...]` sorted by similarity descending.

## `get_stats`

Report loaded corpus statistics.

Returns `{ totalNotes, totalBlocks, embeddingDimension, modelKey }`.

## Tips

- Short keyword queries (1–4 words) outperform full sentences — embeddings are short-context.
- Lower the threshold to 0.3 if nothing comes back; the server already auto-retries at 0.3 when an initial search returns empty.
- For multilingual vaults, include translations in a single `query` array rather than calling repeatedly.
- After semantic search finds a relevant note, switch to structural tools (`read_note`, `read_property`) for exact retrieval. See [Routing](./routing.md).
