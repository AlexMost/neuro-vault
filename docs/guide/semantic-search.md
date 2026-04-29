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

| Mode    | Use when                          | `limit` default | `threshold` default | Block search                                       | Expansion |
| ------- | --------------------------------- | --------------- | ------------------- | -------------------------------------------------- | --------- |
| `quick` | Specific question, need 1–2 notes | 3               | 0.50                | scoped to matched notes, threshold = 0, cap = 5    | off       |
| `deep`  | Broad topic, need an overview     | 8               | 0.35                | across whole vault, threshold = mode, limit = mode | on, top-3 |

`limit` widens or narrows the `results` array but does not affect `blockResults` (which is always capped by mode-specific logic). `expansion` is no longer a tool parameter — it is fixed by mode.

### Output shape — `quick`

```json
{
  "results": [
    { "path": "Projects/neuro-vault.md", "similarity": 0.81 },
    { "path": "Notes/embeddings.md", "similarity": 0.74 }
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
- `truncated: true` means unique merged candidates exceeded `limit`. Widen `limit` to see more. `limit` is the **final** result count — it is not multiplied by the number of queries; passing more queries widens coverage, not result count.

### Output shape — deep mode with expansion

In `deep` mode, after the top-`limit` query results are merged and capped, expansion runs once on those seed results to pull in semantically related notes. Expansion-derived results carry `via_expansion: true` and have no `matched_queries`:

```json
{
  "results": [
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.82,
      "matched_queries": ["embeddings", "векторний пошук"]
    },
    {
      "path": "Notes/vector-search-internals.md",
      "similarity": 0.71,
      "via_expansion": true
    }
  ],
  "blockResults": [],
  "truncated": false
}
```

`matched_queries` and `via_expansion` are mutually exclusive: a result came from a query or from expansion, never both.

### Tuning threshold

- **0.50** (quick default) — confident matches only. Most matches are visibly relevant; misses are common.
- **0.35** (deep default) — broader net. Some weaker matches mixed in; more recall.
- **0.30** — automatic fallback floor used when initial results are empty. Useful manual setting when you really do not want a "nothing found" answer.
- **0.60+** — strict. Use when getting too much noise. Below ~0.7 weakens fast in this embedding model.

### When to pass multiple queries

Pass `query: string[]` (up to 8) instead of calling `search_notes` multiple times. The server batch-embeds all queries in parallel and returns one merged ranked list. Each result's `matched_queries` tells you which synonym was load-bearing.

Common patterns:

- **Synonyms / reformulations** — `["LLM agents", "AI agent system", "autonomous agents"]`
- **Cross-language** — `["optimization", "оптимізація"]` (UA/EN pair)
- **Three-way synonym** — `["MCP server", "MCP сервер", "neuro-vault"]`

The only reason to call more than once: the first call returned nothing and lowering the threshold didn't help — try a different keyword set.

## `get_similar_notes`

Find notes related to a given note path — combining **semantic similarity** (embedding neighbours) with **forward links** (`[[wikilinks]]` from the note's body and frontmatter). Use this **after** `search_notes` finds a relevant note: it discovers related content without needing a text query, and it surfaces what the note's author already declared as relevant via wikilinks.

```typescript
get_similar_notes({
  path: string,                // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
  limit?: number,              // default: 10
  threshold?: number,          // default: 0.5 (semantic branch only)
  exclude_folders?: string[],  // default: ['Templates', 'System', 'Daily', 'Archive']
})
```

Returns:

```typescript
Array<{
  path: string;
  similarity?: number; // present iff a semantic score is set
  signals: {
    semantic?: number; // mirrors top-level similarity for caller convenience
    forward_link?: true; // the query note links to this result via [[...]]
  };
}>;
```

Behaviour:

- A result reachable purely via a forward link has **no** top-level `similarity`. Code that ranks by `similarity` must guard for `undefined`.
- `threshold` filters the **semantic** branch only — forward-linked results bypass it.
- Forward-linked results rank ahead of semantic-only ones; within each bucket, by `signals.semantic` desc, then path asc.
- `exclude_folders` matches case-sensitively as `path === entry || path.startsWith(entry + '/')`. Pass `[]` to disable exclusions.

> **Breaking change in v4.0.0** — the output shape gained the `signals` object and `similarity` became optional. Prior shape was `Array<{ path, similarity }>`.

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
- After semantic search finds a relevant note, switch to structural tools (`read_notes`, `read_property`) for exact retrieval. See [Routing](./routing.md).
