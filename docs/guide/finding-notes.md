# Finding Notes

Everything for locating notes: fuzzy recall over meaning, exact text matching, structured metadata queries, and graph/similarity traversal once you have a starting note. One entry point (`search_notes`) covers the first two; `query_notes` covers the third; `get_similar_notes` / `find_duplicates` / `get_note_links` cover the fourth.

For the retrieval internals behind each tool, see [`docs/architecture/`](../architecture/): [`retrieval-policy.md`](../architecture/retrieval-policy.md) (semantic leg), [`lexical-search.md`](../architecture/lexical-search.md) (lexical leg), [`query.md`](../architecture/query.md) (`query_notes`).

## One search entry point

### `search_notes`

`search_notes` is hybrid: one call fuses a **semantic leg** (embedding cosine similarity over the Smart Connections corpus — fuzzy recall, topic exploration, cross-language), a **lexical leg** (exact/substring text matching over note titles, headings, and body — names, codes, terms), and (in `effort: "deep"`) an **expansion leg** (semantic neighbours of the top hits) into **one reciprocal-rank-fused list**, `matches[]`. A note surfaced by more than one leg is lifted in the merged order automatically — you never have to cross-reference separate lists by hand.

```typescript
search_notes({
  query: string | string[],     // 1-4 word keywords; array of 1-8 for synonyms / translations
  mode?: 'hybrid' | 'lexical',  // which legs run — default: 'hybrid'
  effort?: 'quick' | 'deep',    // candidate volume / exploration depth — default: 'quick'
  limit?: number,               // caps `matches[]` in every mode; does not change any leg's pool size
  threshold?: number,           // semantic leg only, 0-1
  filter?: {                    // optional: narrow candidate set before ranking, every leg
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
| `hybrid`  | semantic + lexical + expansion (default)          | default — you don't know in advance which channel will land     |
| `lexical` | lexical only — never touches the embedding corpus | exact term/name/code, or the vault has no embedding corpus at all |

#### `effort` — candidate volume / exploration depth

| Effort  | Use when                          | Semantic pool | Lexical pool | Expansion | Merged-list cap (`matches[]`, unless `limit` overrides) |
| ------- | ---------------------------------- | -------------- | -------------- | ----------- | ---------------------------------------------------------- |
| `quick` | Specific question, need 1–2 notes | up to 3        | ~5             | off         | 5                                                            |
| `deep`  | Broad topic, need an overview     | up to 8        | ~10            | on          | 12                                                           |

`limit` bounds only the final fused `matches[]` list, in every mode — it overrides the effort default merged-list cap but never changes a leg's internal pool size (semantic, lexical, or expansion). To widen a leg's own candidate pool, raise `effort` to `"deep"` instead. `threshold` only ever affects the semantic leg — the lexical leg has no similarity score to threshold. For how the three legs fuse into one order, see [`docs/architecture/rank-fusion.md`](../architecture/rank-fusion.md).

### Pre-filter (`filter` parameter)

Pass `filter` to narrow the candidate set **before** ranking — applies identically to every leg. Useful when the vault contains many narrative notes that otherwise crowd the top-K on a niche query, or many notes share a common lexical token.

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

Composition: include → exclude → tags → frontmatter → (threshold → semantic similarity | lexical matching), then fusion. The output shape is unchanged — just smaller and more relevant, across every leg.

Example — carve out absorbed atoms and dead notes from a broad query:

```json
{
  "query": "active thinking",
  "effort": "deep",
  "filter": { "exclude_path_prefix": ["Resources/", "Archive/"] }
}
```

### Output shape

Every call returns `{ matches, truncated }`, plus `query_stats` when `query` is an array. `matches[]` is always present, `[]` when nothing matched on any leg.

```json
{
  "matches": [
    {
      "path": "Notes/embeddings.md",
      "vault": "Obsidian",
      "backlink_count": 4,
      "found_in": ["semantic", "lexical:title"],
      "similarity": 0.82,
      "blocks": [
        {
          "heading": "Notes/embeddings.md#What is an embedding",
          "lines": [3, 20],
          "similarity": 0.71
        }
      ],
      "lexical": [{ "matched_in": "title", "snippet": "embeddings" }]
    },
    {
      "path": "Notes/vector-search-internals.md",
      "vault": "Obsidian",
      "backlink_count": 2,
      "found_in": ["expansion"],
      "expansion_similarity": 0.89
    }
  ],
  "truncated": false
}
```

Each entry carries `path`, `vault`, `backlink_count`, and `found_in` — a non-empty array naming every source that surfaced it, drawn from `"semantic"`, `"lexical:title"`, `"lexical:heading"`, `"lexical:body"` (one per distinct lexical kind matched), and `"expansion"`. Per-source evidence accompanies its provenance and only its provenance:

- `similarity` and `blocks[]` (section-level matches within the note) — present iff `found_in` contains `"semantic"`.
- `lexical[]` (capped ~3/note, `{ matched_in: "title" | "heading" | "body", snippet, lines?, heading? }`) — present iff `found_in` contains any `"lexical:*"` value. `heading` on a body match names its enclosing section. **No numeric score** on this evidence — order plus `matched_in` carried the ranking signal into the fused order already.
- `expansion_similarity` (note-to-note similarity to the seed that surfaced it — a **different scale** from `similarity`, do not compare them numerically) — present iff `found_in` contains `"expansion"`. An expansion-only entry (like the second one above) is evidence-light by design: no `similarity`, no `blocks`, no `lexical` — path, provenance, `expansion_similarity`, and `backlink_count` only. Call `read_notes` or `get_similar_notes` on it for more.
- `matched_queries` — array queries only, the union of queries that hit the note in any leg.

`backlink_count` is the total number of inbound wikilinks and `![[embeds]]` derived from the same in-memory index used by `get_note_links` and `query_notes`. It no longer participates in fusion ordering — it's response enrichment the model can weigh itself (see [`rank-fusion.md`](../architecture/rank-fusion.md)).

Each note appears **at most once** in `matches[]`, even when multiple legs surface it — that's the whole point of fusing instead of returning separate lists: a note in two or three sources is lifted automatically, no caller-side merging required. `expansion` never competes against a note that's already a semantic result — an entry's `found_in` never contains both `"semantic"` and `"expansion"` for the same path.

`truncated` (top-level, always present) is true when candidates were dropped anywhere on the way to `matches[]` — either the merged-list cap or a leg's own internal pool cap. The two causes need different fixes: merged-cap truncation is recovered by raising `limit`; a leg's pool-cap truncation is not — raise `effort` to `"deep"` (or narrow `query`/`filter`) instead. See [`rank-fusion.md`](../architecture/rank-fusion.md#truncated-observability-the-1-over-fetch) for the mechanism.

### `query_stats` (array queries only)

For an array `query`, the response also includes `query_stats` — one line per input query, with pre-cap hit counts from each leg:

```json
{
  "query": ["monetization research", "Мобі"],
  "effort": "deep"
}
```

```json
{
  "matches": [ /* ... */ ],
  "truncated": false,
  "query_stats": {
    "monetization research": { "semantic": 4, "lexical": 1 },
    "Мобі": { "semantic": 0, "lexical": 0 }
  }
}
```

`{ semantic, lexical }` counts are taken **before** cross-query merging and **before** the `matches[]` cap — a query whose hits were entirely cut by the merged-list cap still reports its real pre-cap counts, so `{ semantic: 0, lexical: 0 }` reliably means "this phrasing found nothing anywhere," not "this phrasing's hits lost out to a bigger cap." That's the dead-variant signal: rephrase or drop that query, keep the ones with non-zero counts. `query_stats` is omitted entirely for a single string `query`.

For more on the semantic pipeline (merge, cap, per-seed expansion, orphan-block scoping), see [`docs/architecture/retrieval-policy.md`](../architecture/retrieval-policy.md). For the lexical pipeline (normalization, AST blocks, tiers, density, snippets), see [`docs/architecture/lexical-search.md`](../architecture/lexical-search.md). For how the three legs become one ranked list, see [`docs/architecture/rank-fusion.md`](../architecture/rank-fusion.md).

### Lexical matching semantics

- Case-, accent-, and apostrophe-variant-insensitive **substring** matching (not word-boundary) — Ukrainian declensions make substring the right recall bias (`пошук` ⊂ `пошуком`).
- A multiword query requires ALL tokens to appear somewhere in the same unit (AND semantics); a contiguous phrase match ranks higher than a scattered-tokens match at the same location.
- Ranking is six deterministic tiers — title/heading/body × phrase/tokens — with density (matched-chars ÷ unit length) as the tie-break within a tier, then `backlink_count` desc, then `path` asc. No opaque scoring, byte-for-byte reproducible. This is the order rank fusion consumes for the lexical source — see [`rank-fusion.md`](../architecture/rank-fusion.md).
- `mode: "lexical"` never touches the embedding corpus loader — it works even when the vault has a cold or absent Smart Connections index. In this mode `matches[]` preserves the lexical leg's order exactly and every `found_in` is lexical-only.

### Tuning threshold (semantic leg)

- **0.50** (`quick` default) — confident matches only. Most matches are visibly relevant; misses are common.
- **0.35** (`deep` default) — broader net. Some weaker matches mixed in; more recall.
- **0.30** — automatic fallback floor used when initial results are empty. Useful manual setting when you really do not want a "nothing found" answer.
- **0.60+** — strict. Use when getting too much noise. Below ~0.7 weakens fast in this embedding model.

There is no equivalent knob for the lexical leg — an exact/substring match either exists or it doesn't; use `filter` to narrow scope instead of a threshold.

### When to pass multiple queries

Pass `query: string[]` (up to 8) instead of calling `search_notes` multiple times. The server batch-embeds all queries in parallel for the semantic leg and evaluates all queries against the lexical leg in one pass, merging per-query hits into each leg's single source ranking before fusion runs once over the merged sources. Each result's `matched_queries` tells you which synonym was load-bearing; `query_stats` tells you which synonym found nothing at all.

Common patterns:

- **Synonyms / reformulations** — `["LLM agents", "AI agent system", "autonomous agents"]`
- **Cross-language** — `["optimization", "оптимізація"]` (UA/EN pair)
- **Three-way synonym** — `["MCP server", "MCP сервер", "neuro-vault"]`

The only reason to call more than once: the first call returned nothing on any leg (check `query_stats`) and lowering the threshold / trying `filter` didn't help — try a different keyword set.

### Tips

- Short keyword queries (1–4 words) outperform full sentences on the semantic leg — embeddings are short-context. The lexical leg tokenizes on whitespace, so the same short queries work well there too.
- A note surfaced by multiple legs (`found_in` with more than one value) is the strongest relevance signal `search_notes` can hand back — rank fusion already lifts it for you, no manual cross-referencing needed.
- Lower the threshold to 0.3 if the semantic leg comes back empty; the server already auto-retries at 0.3 when an initial search returns empty. The lexical leg has no such fallback — an entry with no `lexical:*` value in `found_in` means no exact match exists for that note.
- For multilingual vaults, include translations in a single `query` array rather than calling repeatedly, and check `query_stats` for dead variants.
- No embedding corpus, or a cold one? Use `mode: "lexical"` explicitly, or just trust `hybrid`'s graceful degradation — the merge falls back to the lexical source alone and `matches[]` still works.
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
