# Finding Notes

Everything for locating notes: fuzzy recall over meaning, exact text matching, structured metadata queries, and graph/similarity traversal once you have a starting note. One entry point (`search_notes`) covers the first two; `query_notes` covers the third; `get_similar_notes` / `find_duplicates` / `get_note_links` cover the fourth.

For the retrieval internals behind each tool, see [`docs/architecture/`](../architecture/): [`retrieval-policy.md`](../architecture/retrieval-policy.md) (semantic leg), [`lexical-search.md`](../architecture/lexical-search.md) (lexical leg), [`query.md`](../architecture/query.md) (`query_notes`).

## One search entry point

### `search_notes`

`search_notes` is hybrid: one call returns a **semantic leg** (embedding cosine similarity over the Smart Connections corpus — fuzzy recall, topic exploration, cross-language) and a **lexical leg** (exact/substring text matching over note titles, headings, and body — names, codes, terms), independent of each other.

```typescript
search_notes({
  query: string | string[],     // 1-4 word keywords; array of 1-8 for synonyms / translations
  mode?: 'hybrid' | 'lexical',  // which legs run — default: 'hybrid'
  effort?: 'quick' | 'deep',    // result volume / exploration depth — default: 'quick'
  limit?: number,               // steers semantic_matches in hybrid, lexical_matches in lexical
  threshold?: number,           // semantic leg only, 0-1
  filter?: {                    // optional: narrow candidate set before ranking, both legs
    path_prefix?: string | string[],
    exclude_path_prefix?: string | string[],
    tags?: string[],
    frontmatter?: object,
  },
})
```

`mode` and `effort` are two orthogonal axes — intent (how much work) is independent of channel (which legs run).

#### `mode` — which legs run

| Mode      | Runs                                              | Use when                                                        |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| `hybrid`  | semantic + lexical (default)                     | default — you don't know in advance which channel will land     |
| `lexical` | lexical only — never touches the embedding corpus | exact term/name/code, or the vault has no embedding corpus at all |

#### `effort` — result volume / exploration depth

| Effort  | Use when                          | `limit` default (semantic) | `threshold` default | Semantic block search                                    | Expansion                      | Lexical note cap |
| ------- | ---------------------------------- | --------------------------- | -------------------- | ---------------------------------------------------------- | -------------------------------- | ------------------ |
| `quick` | Specific question, need 1–2 notes | 3                            | 0.50                  | scoped to result notes, threshold = 0, cap = 5 per note   | off                               | ~5                  |
| `deep`  | Broad topic, need an overview     | 8                            | 0.35                  | scoped to result notes, threshold = mode, limit = mode    | on, per-seed cap = 3 (default)  | ~10                 |

`limit` widens or narrows `semantic_matches[]` in `hybrid` mode (or `lexical_matches[]` directly in `lexical` mode) but does not directly bound nested `blocks[]`, `related[]`, or per-note `matches[]`, which are capped per result (see tables above). `expansion` is not a tool parameter — it is fixed by `effort`. `threshold` only ever affects the semantic leg — the lexical leg has no similarity score to threshold.

### Pre-filter (`filter` parameter)

Pass `filter` to narrow the candidate set **before** ranking — applies identically to both legs. Useful when the vault contains many narrative notes that otherwise crowd the top-K on a niche query, or many notes share a common lexical token.

```json
{
  "query": ["trading lessons", "торговельна рефлексія"],
  "effort": "deep",
  "filter": { "tags": ["trading"] }
}
```

`filter` accepts four optional fields (at least one required):

- `path_prefix` — scope to a vault subtree (e.g. `"Resources/"`) or array of subtrees for OR-semantics (e.g. `["Tasks/", "Reflections/"]`).
- `exclude_path_prefix` — drop notes whose path starts with any of the listed prefixes (e.g. `["Resources/", "Archive/"]`). Valid as the sole filter field — "search the whole vault except those subtrees".
- `tags` — string array; matches any note carrying ANY of these tags (no leading `#`).
- `frontmatter` — sift filter against frontmatter keys; same operator allow-list as `query_notes` (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$and`, `$or`, `$nor`, `$not`).

Composition: include → exclude → tags → frontmatter → (threshold → semantic similarity | lexical matching). The output shape is unchanged — just smaller and more relevant, on both legs.

Example — carve out absorbed atoms and dead notes from a broad query:

```json
{
  "query": "active thinking",
  "effort": "deep",
  "filter": { "exclude_path_prefix": ["Resources/", "Archive/"] }
}
```

### Output shape

Every call returns both keys, regardless of `mode` — `lexical_matches` is `[]` (never absent) when `mode: "hybrid"` finds nothing lexically, and `semantic_matches` is `[]` when `mode: "lexical"`, or when no embedding corpus is available for the vault (hybrid degrades gracefully to lexical-only rather than erroring).

```json
{
  "semantic_matches": [
    {
      "path": "Projects/neuro-vault.md",
      "similarity": 0.81,
      "backlink_count": 7,
      "vault": "Obsidian",
      "blocks": [
        { "heading": "Projects/neuro-vault.md#Architecture", "lines": [42, 58], "similarity": 0.79 }
      ],
      "related": []
    }
  ],
  "lexical_matches": [
    {
      "path": "Notes/embeddings.md",
      "backlink_count": 2,
      "vault": "Obsidian",
      "matches": [
        { "matched_in": "title", "snippet": "embeddings" },
        {
          "matched_in": "body",
          "snippet": "…the Smart Connections embeddings corpus loaded into memory…",
          "lines": [12, 14],
          "heading": "What is an embedding"
        }
      ]
    }
  ]
}
```

**`semantic_matches[]`** — each direct result is a node with:

- `path`, `similarity` (query-similarity), `backlink_count`, `vault` — basic identity.
- `blocks[]` — section-level matches WITHIN this note (own-path scope). Always present; possibly empty.
- `related[]` — expansion neighbours OF this note. Always present; populated only in `effort: "deep"`.

`backlink_count` is the total number of inbound wikilinks and `![[embeds]]` derived from the same in-memory index used by `get_note_links` and `query_notes`. Useful as a relevance signal when several results have similar similarity scores.

**`lexical_matches[]`** — grouped per note: `path`, `backlink_count`, `vault`, optional `matched_queries` (multi-query only), and `matches[]` (capped ~3/note) of `{ matched_in: "title" | "heading" | "body", snippet, lines?, heading? }`. `heading` on a body match names its enclosing section. **No numeric score** — order and `matched_in` carry the ranking (title > heading > body; exact phrase > all-tokens within each level). `matches[]` is always non-empty on a lexical item; an empty `lexical_matches` means literally no exact match was found anywhere — unlike the semantic leg, the lexical leg does not degrade to weak matches.

### Intersection signal

A note appearing in **both** `semantic_matches` and `lexical_matches` for the same query is the strongest relevance evidence the tool can hand back — the meaning and the exact wording agree. There is no explicit "intersection" field; check for a shared `path` across the two arrays and weight those notes first. This is the whole point of one hybrid entry point instead of two separate tools: the intersection signal only exists because both legs run together and the LLM can fuse the two lists for free.

### Output shape — multi-query (`query` is an array)

```json
{
  "semantic_matches": [
    {
      "path": "Notes/embeddings.md",
      "similarity": 0.82,
      "matched_queries": ["embeddings", "векторний пошук"],
      "backlink_count": 4,
      "vault": "Obsidian",
      "blocks": [],
      "related": []
    }
  ],
  "lexical_matches": [
    {
      "path": "Notes/embeddings.md",
      "backlink_count": 4,
      "vault": "Obsidian",
      "matched_queries": ["embeddings"],
      "matches": [{ "matched_in": "title", "snippet": "embeddings" }]
    }
  ],
  "truncated": false
}
```

- `matched_queries` (per result, on both legs) lists which of your queries surfaced this note. If only one of your synonyms hit, that's a useful signal.
- `truncated: true` (top-level) means unique merged candidates exceeded `limit`. Widen `limit` to see more. `limit` is the **final** result count — it is not multiplied by the number of queries; passing more queries widens coverage, not result count.

### Expansion (`related[]`) in `effort: "deep"`

In `deep` mode, after the top-`limit` result notes are merged and capped, expansion runs per-seed: for each direct semantic result, the server pulls its semantically nearest neighbour notes into `related[]` on that result. The neighbour's score is `expansion_similarity` (note-to-note), a **different scale** from the top-level `similarity` (query-to-note); do not compare them numerically.

```json
{
  "semantic_matches": [
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
  "lexical_matches": [],
  "truncated": false
}
```

Invariants:

- A `related[]` item never has a `similarity` field — only `expansion_similarity`. A direct semantic result never has `expansion_similarity`.
- The same neighbour may appear in `related[]` of multiple direct results, with potentially different `expansion_similarity` values per parent. This is by design — neighbourhood is a pairwise property.
- `blocks[]` and `related[]` are always present on semantic results (possibly empty); `matches[]` is always non-empty on lexical items.
- `similarity` / `expansion_similarity` appear ONLY on semantic nodes; lexical items never carry a numeric score.
- After finding a relevant note, call `get_similar_notes` on it for a deeper neighbour profile — don't infer relationships from `related[]` alone.

For more on the semantic pipeline (merge, cap, per-seed expansion, orphan-block scoping), see [`docs/architecture/retrieval-policy.md`](../architecture/retrieval-policy.md). For the lexical pipeline (normalization, AST blocks, tiers, density, snippets), see [`docs/architecture/lexical-search.md`](../architecture/lexical-search.md).

### Lexical matching semantics

- Case-, accent-, and apostrophe-variant-insensitive **substring** matching (not word-boundary) — Ukrainian declensions make substring the right recall bias (`пошук` ⊂ `пошуком`).
- A multiword query requires ALL tokens to appear somewhere in the same unit (AND semantics); a contiguous phrase match ranks higher than a scattered-tokens match at the same location.
- Ranking is six deterministic tiers — title/heading/body × phrase/tokens — with density (matched-chars ÷ unit length) as the tie-break within a tier, then `backlink_count` desc, then `path` asc. No opaque scoring, byte-for-byte reproducible.
- `mode: "lexical"` never touches the embedding corpus loader — it works even when the vault has a cold or absent Smart Connections index.

### Tuning threshold (semantic leg)

- **0.50** (`quick` default) — confident matches only. Most matches are visibly relevant; misses are common.
- **0.35** (`deep` default) — broader net. Some weaker matches mixed in; more recall.
- **0.30** — automatic fallback floor used when initial results are empty. Useful manual setting when you really do not want a "nothing found" answer.
- **0.60+** — strict. Use when getting too much noise. Below ~0.7 weakens fast in this embedding model.

There is no equivalent knob for the lexical leg — an exact/substring match either exists or it doesn't; use `filter` to narrow scope instead of a threshold.

### When to pass multiple queries

Pass `query: string[]` (up to 8) instead of calling `search_notes` multiple times. The server batch-embeds all queries in parallel for the semantic leg and evaluates all queries against the lexical leg in one pass, returning one merged ranked list per leg. Each result's `matched_queries` tells you which synonym was load-bearing.

Common patterns:

- **Synonyms / reformulations** — `["LLM agents", "AI agent system", "autonomous agents"]`
- **Cross-language** — `["optimization", "оптимізація"]` (UA/EN pair)
- **Three-way synonym** — `["MCP server", "MCP сервер", "neuro-vault"]`

The only reason to call more than once: the first call returned nothing on both legs and lowering the threshold / trying `filter` didn't help — try a different keyword set.

### Tips

- Short keyword queries (1–4 words) outperform full sentences on the semantic leg — embeddings are short-context. The lexical leg tokenizes on whitespace, so the same short queries work well there too.
- A note in **both** legs is a strong relevance signal — check for it before trusting either list alone.
- Lower the threshold to 0.3 if the semantic leg comes back empty; the server already auto-retries at 0.3 when an initial search returns empty. Empty `lexical_matches` has no such fallback — it means no exact match exists.
- For multilingual vaults, include translations in a single `query` array rather than calling repeatedly.
- No embedding corpus, or a cold one? Use `mode: "lexical"` explicitly, or just trust `hybrid`'s graceful degradation — `semantic_matches` comes back empty and `lexical_matches` still works.
- After search finds a relevant note, switch to structural tools (`read_notes`, `query_notes`) for exact retrieval. See [Routing](./routing.md).

## Structured queries

### `query_notes`

Run a multi-criteria query against the vault using a MongoDB-style filter — replaces N+1 patterns like "list tags → read each note's property → filter in head" with one call. Also serves as the canonical way to list notes carrying a specific tag (`{ filter: { tags: '<name>' } }`).

```typescript
query_notes({
  filter: object,              // MongoDB-style query (see below)
  path_prefix?: string | string[],   // restrict scan to a subtree (or several), e.g. "Projects/" or ["Tasks/", "Reflections/"]
  exclude_path_prefix?: string | string[], // drop notes whose path starts with any listed prefix (e.g. ["Daily/", "Archive/"])
  sort?: { field: string, order: 'asc' | 'desc' },
  limit?: number,              // default 100, max 1000
  include_content?: boolean,   // default false
})
```

The filter is evaluated against a `NoteRecord` shape:

```ts
{
  path: string,           // "Projects/foo.md"
  frontmatter: object,    // parsed YAML, full passthrough
  tags: string[],         // normalized, no leading "#", from frontmatter `tags:`
  backlink_count: number, // total inbound wikilinks + embeds across the vault
}
```

Reference frontmatter keys with the dotted prefix `frontmatter.<key>`. Reference tags via the top-level `tags` array (sift exact-match against array elements). `backlink_count` is a top-level scalar — filterable (`{ backlink_count: { $gte: 5 } }`), sortable (`sort: { field: 'backlink_count', order: 'desc' }`), and always present on each result item.

**Supported operators:** `$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`, `$lt`, `$lte`, `$exists`, `$regex`, `$options`, `$and`, `$or`, `$nor`, `$not`. Anything else is rejected as `INVALID_FILTER`.

**`$regex` is case-insensitive by default.** `{ tags: { $regex: '^ai' } }` matches `#AI`, `#ai`, and `#Ai`. To opt out, pass `$options` explicitly — `{ $regex: '^ai', $options: '' }` for case-sensitive, `{ $regex: '^ai', $options: 'm' }` for multiline-only, `{ $regex: '^ai', $options: 'mi' }` for both.

**Examples:**

```json
// active todo tasks in active projects
{ "frontmatter.status": "todo", "frontmatter.project_status": "active" }
```

```json
// notes tagged #ai with status active or wip, created this year
{
  "$and": [
    { "tags": "ai" },
    { "$or": [{ "frontmatter.status": "active" }, { "frontmatter.status": "wip" }] },
    { "frontmatter.created": { "$gte": "2026-01-01" } }
  ]
}
```

```json
// notes that have a deadline set
{ "frontmatter.deadline": { "$exists": true } }
```

**Tag matching is exact (sift default):** `"ai"` does NOT match `#ai/ml`. To match a hierarchy, write `{ "tags": { "$in": ["ai", "ai/ml"] } }` or `{ "tags": { "$regex": "^ai(/|$)" } }` explicitly.

**Result shape:** `{ results: [{ path, frontmatter, backlink_count, content? }], count, truncated }`. `count === results.length` (what we returned), and `truncated === true` ⇔ matched count exceeded `limit`. When `truncated` is true, narrow the filter or raise `limit` (capped at 1000).

`include_content: true` returns the body alongside metadata — saves a follow-up `read_notes` call when you know up-front that bodies are needed, but grows the response significantly. Default off.

`query_notes` is exact and structural, not fuzzy — it does not read note bodies for matching (unless `include_content` is requested for the return payload) and cannot substring-match prose. For exact text inside a note's title/headings/body, use `search_notes({ mode: "lexical" })` instead; use `query_notes` when you already know the structural key (a frontmatter field, a tag, a folder).

## Similarity & graph

### `get_similar_notes`

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

### `find_duplicates`

Find note pairs with high embedding similarity. Useful for vault maintenance — identifies notes that cover the same topic and could be merged.

```typescript
find_duplicates({
  threshold?: number, // default: 0.9
})
```

Returns `[{ note_a, note_b, similarity }, ...]` sorted by similarity descending.

### `get_note_links`

Return the wikilink adjacency for a single note: the full incoming and outgoing edge lists derived from the vault-wide wikilink graph (`[[X]]` and `![[X]]` embeds, in body or frontmatter).

```typescript
get_note_links({
  path: string, // vault-relative POSIX path, e.g. "Projects/neuro-vault.md"
});
```

Paths without an extension are treated as `.md` notes.

Returns:

```typescript
{
  incoming: { source: string }[],
  outgoing: {
    target: string,            // raw wikilink text (no display alias, no section anchor)
    resolved: boolean,         // false ⇔ no note exists yet for this name
    path?: string,             // vault path of the resolved target (only when resolved)
  }[],
}
```

- **Embeds count as wikilinks.** `![[X]]` produces an outgoing edge to `X`, exactly like `[[X]]`.
- **Unresolved targets are kept** (`resolved: false`) — useful when surfacing concepts the user has anchored but not yet written.
- **Self-links are dropped** — a note linking to itself does not appear in its own `incoming` or `outgoing`.
- **Backed by an in-memory index** that rebuilds lazily on query when older than 3 minutes; the first call after a stale window pays the rebuild cost. No watchers, no background timers.
- Reads directly from disk; does not require Obsidian to be running.

Use this **after** `search_notes` or `query_notes` finds a starting note, to traverse the graph around it. For ranking by inbound popularity rather than walking edges, see `backlink_count` on `query_notes` and `search_notes` results.
