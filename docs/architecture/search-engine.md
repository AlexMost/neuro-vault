# Search Engine

The pure-math layer: cosine similarity, neighbor finding, block-level search, and duplicate detection.

## What it is

`src/search-engine.ts` exports three functions:

- `findNeighbors({ queryVector, sources, threshold, limit, excludePath })` — sources ranked by similarity to the query
- `findBlockNeighbors({ queryVector, sources, threshold, limit })` — block-level (heading + line range) results
- `findDuplicates({ sources, threshold })` — pairs of sources with similarity above the threshold

All three use the same `cosineSimilarity` helper. The functions are pure: same inputs always produce the same outputs, no I/O, no logging, no global state.

## Why it exists

The semantic search workflow boils down to "compare a vector against a bag of vectors." Isolating that math from the rest of the system means:

- Tests can hand in synthetic vectors and check exact rankings.
- Tool handlers do not need to know how similarity is computed.
- An alternative implementation (e.g. ANN index) could swap in behind the same `SearchEngine` interface (`src/types.ts`) without touching handlers.

## How it interacts

```
queryVector + sources + threshold
  │
  ▼
for each source: cosineSimilarity → keep if ≥ threshold
  │
  ▼
sort by similarity DESC, then path ASC (stable, deterministic)
  │
  ▼
slice to limit
```

`findBlockNeighbors` runs the same loop one level deeper — over `source.blocks` instead of `sources`. Blocks with empty embeddings are skipped (some blocks are too small for Smart Connections to embed).

`findDuplicates` runs an `O(n²)` upper-triangular comparison over all pairs. The pair is sorted alphabetically (`note_a` ≤ `note_b`) so the same pair is never reported twice and the output is order-independent.

## Determinism

Sort order is fully deterministic:

- Primary: similarity descending (`right.similarity - left.similarity`)
- Secondary: path ascending (`localeCompare`)

Stable sort keys matter because the corpus iteration order can vary; without the secondary key, two notes at the same similarity would shuffle between runs, breaking tests and surprising users.

## Validation

Every comparison checks:

- Vectors are non-empty.
- Vectors share a dimension. A mismatch throws with both labels — easier to trace than "Vector dimension mismatch" alone.

These checks live here, not in handlers, because the same invariant applies to every entry point.

## Boundaries

- The engine does not embed text. It receives vectors and returns rankings.
- The engine does not filter by date, tag, folder, or any other structural attribute. Those would be a separate concern (and live elsewhere if added).
- The engine does not hold the corpus. It receives an `Iterable<SmartSource>` so callers can pass a subset (e.g. matched paths only, in `quick` mode block search).
