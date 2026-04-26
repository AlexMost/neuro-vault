# Retrieval Policy

How a search request becomes a ranked set of notes and blocks. This is the "policy" layer that composes the embedding pipeline, the corpus, and the search engine into the behaviour described to the LLM.

## What it is

`src/retrieval-policy.ts` exports a single function, `executeRetrieval(input)`, that runs a four-step pipeline:

1. Embed the query.
2. Find note-level neighbors (with a fallback if nothing matches).
3. Find block-level neighbors (scoping varies by mode).
4. Optionally expand by treating top results as new query vectors.

The output is `{ results: SearchResult[], blockResults?: BlockSearchResult[] }`.

## Why it exists

The search engine is pure math; the LLM-facing tool needs a higher-level behaviour: "if the user wants a quick lookup, give me a few high-confidence matches; if the user is exploring, cast a wider net and surface relevant paragraphs." Encoding that behaviour as a policy keeps the math layer simple and gives one place to tune the trade-offs.

## Modes

```
quick: limit=3, threshold=0.50, expansion=off
deep:  limit=8, threshold=0.35, expansion=on, expansionLimit=3
```

- `quick` is the default — used for specific lookups where the LLM expects a small, precise answer set.
- `deep` lowers the threshold, doubles+ the limit, and turns on expansion — used for "tell me about X" exploration.

The LLM picks the mode based on intent; the user can override per call.

## Step 1 — Embedding

Just calls `embeddingProvider.embed(query)`. If embedding fails, the policy lets the error bubble; the tool handler wraps it as `DEPENDENCY_ERROR`.

## Step 2 — Note-level neighbors with threshold fallback

```
results = findNeighbors(threshold)
if results is empty AND threshold > 0.3:
    results = findNeighbors(0.3)
```

The fallback exists because users rarely tune the threshold, and the difference between "no results" and "weak results" is more useful than silence. The 0.3 floor stays high enough to keep results meaningful but low enough to surface weak matches the user can decide about.

## Step 3 — Block-level results, scoped by mode

- `deep` mode: search blocks across the entire corpus. The user wants depth, so we surface the most relevant paragraphs anywhere.
- `quick` mode: search blocks **only inside the matched note set**, with a high cap (`QUICK_BLOCK_LIMIT = 5`) and threshold 0. The intent is to point at the exact paragraph inside an already-narrowed note, not to broaden the search.

When `quick` mode finds zero notes, no block search runs.

## Step 4 — Expansion

If `expansion` is on and there are results, the top `expansionLimit` notes are used as additional query vectors:

```
for top in vectorResults.slice(0, expansionLimit):
    extra = findNeighbors(queryVector = top.embedding, threshold)
    vectorResults = dedupe(vectorResults + extra)
```

Deduplication keeps the highest similarity per path. The final `slice(0, limit)` enforces the mode's limit after merging.

Expansion catches notes that are semantically adjacent to top results but did not match the original query directly — typical for broad topical questions.

## Multi-query

`executeMultiRetrieval(input)` is a sibling of `executeRetrieval` for callers that want to search several reformulations at once (synonyms, UA/EN variants, related concepts). It runs the existing four-step pipeline once per query in parallel via `Promise.all`, then merges the per-query outputs.

Merge rule for note results:

- key by `path`
- similarity is `max` across the queries that matched it
- `matched_queries: string[]` records which queries surfaced this path

Block results merge by `(path, heading, lines)` with the same max-similarity rule.

After merging, results are sorted by similarity descending (with path tiebreak) and capped to `min(limit × N, 50)`, where `limit` is the per-query top-K (user-supplied or mode default) and `N` is the number of unique queries after dedupe. The hard ceiling of 50 bounds response size, not retrieval depth — `truncated: true` signals that more candidates existed than fit in the cap.

The handler in `tool-handlers.ts` decides which path to run based on the runtime type of `input.query`: `string` keeps the legacy single-query shape (no `matched_queries`, no `truncated`); `string[]` (length 1–8 after dedupe) takes the multi-query path.

## Invariants

- Results are sorted by similarity descending (the search engine guarantees this; the policy does not re-sort after expansion, but `dedupe` preserves the highest-similarity entry per path).
- The final note count is bounded by `mode.limit`; block count by `QUICK_BLOCK_LIMIT` (quick) or `mode.limit` (deep).
- A user-supplied `threshold` overrides the mode default; everything else uses mode defaults unless explicitly overridden.

## Stale-path filtering

The Smart Connections embeddings index is keyed by note path. When a file is moved (e.g. `Tasks/foo.md` → `Archive/foo.md`) Smart Connections may not evict the old entry, so `findNeighbors` can return a path that no longer exists on disk. The MCP `search_notes`, `get_similar_notes`, and `find_duplicates` handlers post-filter results through a `pathExists(vaultRelativePath)` predicate and drop entries (and duplicate pairs) whose paths are missing.

The default predicate in `src/modules/semantic/index.ts` is a `fs.access` check rooted at the configured `--vault` directory. Tests inject a fake. The policy itself is unchanged — filtering happens at the handler boundary so the math layer stays pure.

## Boundaries

- The policy does not validate inputs (the tool handler does that).
- The policy does not know about MCP, error codes, or response envelopes. It returns a plain object; the layer above wraps it.
- The policy does not assume the search engine is in-memory. If a different engine is wired in, the same five-step pipeline still applies — only the cost shape changes.
