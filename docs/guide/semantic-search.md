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
  filter?: {                    // optional: narrow candidate set before ranking
    path_prefix?: string | string[],
    exclude_path_prefix?: string | string[],
    tags?: string[],
    frontmatter?: object,
  },
})
```

### Modes

| Mode    | Use when                          | `limit` default | `threshold` default | Block search                                            | Expansion                      |
| ------- | --------------------------------- | --------------- | ------------------- | ------------------------------------------------------- | ------------------------------ |
| `quick` | Specific question, need 1–2 notes | 3               | 0.50                | scoped to result notes, threshold = 0, cap = 5 per note | off                            |
| `deep`  | Broad topic, need an overview     | 8               | 0.35                | scoped to result notes, threshold = mode, limit = mode  | on, per-seed cap = 3 (default) |

`limit` widens or narrows the `results[]` array but does not directly bound nested `blocks[]` or `related[]`, which are capped per result (see modes table). `expansion` is not a tool parameter — it is fixed by mode.

### Pre-filter (`filter` parameter)

Pass `filter` to narrow the candidate set **before** semantic ranking. Useful when the vault contains many narrative notes that otherwise crowd the top-K on a niche query.

```json
{
  "query": ["trading lessons", "торговельна рефлексія"],
  "mode": "deep",
  "filter": { "tags": ["trading"] }
}
```

`filter` accepts four optional fields (at least one required):

- `path_prefix` — scope to a vault subtree (e.g. `"Resources/"`) or array of subtrees for OR-semantics (e.g. `["Tasks/", "Reflections/"]`).
- `exclude_path_prefix` — drop notes whose path starts with any of the listed prefixes (e.g. `["Resources/", "Archive/"]`). Valid as the sole filter field — "search the whole vault except those subtrees".
- `tags` — string array; matches any note carrying ANY of these tags (no leading `#`).
- `frontmatter` — sift filter against frontmatter keys; same operator allow-list as `query_notes` (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`).

Composition: include → exclude → tags → frontmatter → threshold → semantic similarity. The output shape is unchanged — just smaller and more relevant.

Example — carve out absorbed atoms and dead notes from a broad query:

```json
{
  "query": "active thinking",
  "mode": "deep",
  "filter": { "exclude_path_prefix": ["Resources/", "Archive/"] }
}
```

### Output shape — `quick`

```json
{
  "results": [
    {
      "path": "Projects/neuro-vault.md",
      "similarity": 0.81,
      "backlink_count": 7,
      "vault": "Obsidian",
      "blocks": [
        { "heading": "Projects/neuro-vault.md#Architecture", "lines": [42, 58], "similarity": 0.79 }
      ],
      "related": []
    },
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.74,
      "backlink_count": 2,
      "vault": "Obsidian",
      "blocks": [],
      "related": []
    }
  ]
}
```

Each direct result is a node with:

- `path`, `similarity` (query-similarity), `backlink_count`, `vault` — basic identity.
- `blocks[]` — section-level matches WITHIN this note (own-path scope). Always present; possibly empty.
- `related[]` — expansion neighbours OF this note. Always present; populated only in `deep` mode.

`backlink_count` is the total number of inbound wikilinks and `![[embeds]]` derived from the same in-memory index used by `get_note_links` and `query_notes`. Useful as a relevance signal when several results have similar similarity scores.

### Output shape — `deep`

Same shape as quick, but `results[]` can have up to `limit` entries (default 8) and `related[]` is populated on each result with up to `expansionLimit` (default 3) semantically neighbouring notes (see "Expansion" below).

### Output shape — multi-query (`query` is an array)

```json
{
  "results": [
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.82,
      "matched_queries": ["embeddings", "векторний пошук"],
      "backlink_count": 4,
      "vault": "Obsidian",
      "blocks": [],
      "related": []
    },
    {
      "path": "Projects/neuro-vault.md",
      "similarity": 0.76,
      "matched_queries": ["embeddings"],
      "backlink_count": 7,
      "vault": "Obsidian",
      "blocks": [],
      "related": []
    }
  ],
  "truncated": false
}
```

- `matched_queries` (per result) lists which of your queries surfaced this note. If only one of your synonyms hit, that's a useful signal.
- `truncated: true` (top-level) means unique merged candidates exceeded `limit`. Widen `limit` to see more. `limit` is the **final** result count — it is not multiplied by the number of queries; passing more queries widens coverage, not result count.

### Expansion (`related[]`) in `deep` mode

In `deep` mode, after the top-`limit` result notes are merged and capped, expansion runs per-seed: for each direct result, the server pulls its semantically nearest neighbour notes into `related[]` on that result. The neighbour's score is `expansion_similarity` (note-to-note), a **different scale** from the top-level `similarity` (query-to-note); do not compare them numerically.

```json
{
  "results": [
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.82,
      "matched_queries": ["embeddings", "векторний пошук"],
      "backlink_count": 4,
      "vault": "Obsidian",
      "blocks": [
        {
          "heading": "Notes/embeddings.md#What is an embedding",
          "lines": [3, 20],
          "similarity": 0.71
        }
      ],
      "related": [
        { "path": "Notes/vector-search-internals.md", "expansion_similarity": 0.94 },
        { "path": "Resources/Information retrieval.md", "expansion_similarity": 0.88 }
      ]
    }
  ],
  "truncated": false
}
```

Invariants:

- A `related[]` item never has a `similarity` field — only `expansion_similarity`. A direct result never has `expansion_similarity`.
- The same neighbour may appear in `related[]` of multiple direct results, with potentially different `expansion_similarity` values per parent. This is by design — neighbourhood is a pairwise property.
- `blocks[]` and `related[]` are always present on direct results (possibly empty).
- After finding a relevant note, call `get_similar_notes` on it for a deeper neighbour profile — don't infer relationships from `related[]` alone.

For more on the retrieval pipeline (merge, cap, per-seed expansion, orphan-block scoping), see [`docs/architecture/retrieval-policy.md`](../architecture/retrieval-policy.md).

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
  exclude_folders?: string[],  // default: [] (search all folders)
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
- `exclude_folders` matches case-sensitively as `path === entry || path.startsWith(entry + '/')`. Defaults to `[]` (no exclusions); pass folder names to scope the search.

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
