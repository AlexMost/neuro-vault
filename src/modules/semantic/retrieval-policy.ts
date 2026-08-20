import type {
  BlockMatch,
  EmbeddingProvider,
  NoteResultNode,
  RelatedNote,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
} from './types.js';

const FALLBACK_THRESHOLD = 0.3;
const QUICK_BLOCK_LIMIT = 5;
// The expansion leg's similarity floor operates on the seed↔note scale
// (empirically 0.89–0.985 in real corpora) — incomparable with the semantic
// leg's query↔note scale, which is why it is a separate knob. 0.35 matches
// what default calls effectively used before the split (behavior-preserving).
const DEFAULT_EXPANSION_FLOOR = 0.35;

interface ModeConfig {
  limit: number;
  threshold: number;
  expansion: boolean;
  expansionLimit: number;
}

const MODE_DEFAULTS: Record<SearchMode, ModeConfig> = {
  quick: { limit: 3, threshold: 0.5, expansion: false, expansionLimit: 0 },
  deep: { limit: 8, threshold: 0.35, expansion: true, expansionLimit: 3 },
};

// Per-seed expansion. Each seed gets its own sorted, capped list of neighbours.
// No global dedup — the same path may appear in multiple seeds' related lists
// (with potentially different expansion_similarity values), by design.
function computeRelatedPerSeed(args: {
  seedPaths: string[];
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  floor: number;
  perSeedLimit: number;
}): Map<string, RelatedNote[]> {
  const { seedPaths, sources, searchEngine, floor, perSeedLimit } = args;
  const seedSet = new Set(seedPaths);
  const out = new Map<string, RelatedNote[]>();
  for (const seedPath of seedPaths) {
    const source = sources.get(seedPath);
    if (!source || source.embedding.length === 0) {
      out.set(seedPath, []);
      continue;
    }
    const neighbours = searchEngine.findNeighbors({
      queryVector: source.embedding,
      sources: sources.values(),
      threshold: floor,
      limit: perSeedLimit + seedSet.size,
    });
    const related = neighbours
      .filter((n) => !seedSet.has(n.path))
      .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))
      .slice(0, perSeedLimit)
      .map((n) => ({ path: n.path, expansion_similarity: n.similarity }));
    out.set(seedPath, related);
  }
  return out;
}

export interface RetrievalInput {
  queries: string[];
  mode: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  expansionFloor?: number;
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
}

export interface RetrievalOutput {
  results: NoteResultNode[];
  // True when candidates were dropped either by the cross-query merge cap
  // (`limit`) or by any single query's own per-query pool cap. For one query
  // the merge cap can never bind — `neighbors` was already sliced to `limit`
  // — so this reduces exactly to that query's pool overflow.
  truncated: boolean;
  per_query_hits: Record<string, number>;
  per_query_fallback: Record<string, boolean>;
}

interface MergedSeed {
  path: string;
  similarity: number;
  matched_queries: string[];
}

function mergeNoteResults(
  perQuery: Array<{ query: string; results: SearchResult[] }>,
): MergedSeed[] {
  const byPath = new Map<string, MergedSeed>();
  for (const { query, results } of perQuery) {
    for (const result of results) {
      const existing = byPath.get(result.path);
      if (!existing) {
        byPath.set(result.path, {
          path: result.path,
          similarity: result.similarity,
          matched_queries: [query],
        });
        continue;
      }
      if (result.similarity > existing.similarity) {
        existing.similarity = result.similarity;
      }
      if (!existing.matched_queries.includes(query)) {
        existing.matched_queries.push(query);
      }
    }
  }
  return [...byPath.values()].sort(
    (a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path),
  );
}

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { queries, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const explicitThreshold = input.threshold !== undefined;
  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const expansionFloor = input.expansionFloor ?? DEFAULT_EXPANSION_FLOOR;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: per-query embed + retrieve (no expansion here). Request one
  // extra hit beyond `limit` per query so a per-query pool overflow is
  // observable, then immediately slice back down to `limit` — `neighbors`
  // (and therefore `per_query_hits` and the merge step below) keep exactly
  // the same limit-bounded semantics as before the over-fetch; `overflow` is
  // the only new signal carried out of this step.
  const perQueryOutputs = await Promise.all(
    queries.map(async (query) => {
      const queryVector = await embeddingProvider.embed(query);
      let neighbors = searchEngine.findNeighbors({
        queryVector,
        sources: sources.values(),
        threshold,
        limit: limit + 1,
      });
      // Step 2 (per query): fallback threshold — default thresholds only. An
      // explicit threshold that filters everything returns an honest zero.
      let fallback = false;
      if (neighbors.length === 0 && !explicitThreshold && threshold > FALLBACK_THRESHOLD) {
        neighbors = searchEngine.findNeighbors({
          queryVector,
          sources: sources.values(),
          threshold: FALLBACK_THRESHOLD,
          limit: limit + 1,
        });
        fallback = neighbors.length > 0;
      }
      const overflow = neighbors.length > limit;
      neighbors = neighbors.slice(0, limit);
      return { query, queryVector, neighbors, overflow, fallback };
    }),
  );

  const per_query_hits: Record<string, number> = {};
  const per_query_fallback: Record<string, boolean> = {};
  for (const { query, neighbors, fallback } of perQueryOutputs) {
    per_query_hits[query] = neighbors.length;
    per_query_fallback[query] = fallback;
  }

  // Step 2: merge seeds across queries
  const merged = mergeNoteResults(
    perQueryOutputs.map(({ query, neighbors }) => ({ query, results: neighbors })),
  );

  // Step 3: cap to `limit`. `truncated` reflects candidates dropped either
  // by this cross-query merge cap OR by any single query's own pool cap
  // (Step 1's overflow) — both are "a source leg's pool cap" from the
  // caller's perspective.
  const mergeOverflow = merged.length > limit;
  const anyQueryOverflow = perQueryOutputs.some((o) => o.overflow);
  const truncated = mergeOverflow || anyQueryOverflow;
  const seeds = merged.slice(0, limit);
  const seedPaths = seeds.map((s) => s.path);
  const seedPathSet = new Set(seedPaths);

  // Step 4: block search per query, scoped to seed notes; merge by block-key keeping max similarity.
  const blocksByPath = new Map<string, BlockMatch[]>();
  if (seeds.length > 0) {
    const seedSources = [...sources.values()].filter((s) => seedPathSet.has(s.path));
    const rawByKey = new Map<string, BlockMatch & { path: string }>();
    for (const { queryVector } of perQueryOutputs) {
      const raw =
        mode === 'deep'
          ? searchEngine.findBlockNeighbors({
              queryVector,
              sources: seedSources,
              threshold: MODE_DEFAULTS.deep.threshold,
              limit,
            })
          : searchEngine.findBlockNeighbors({
              queryVector,
              sources: seedSources,
              threshold: 0,
              limit: QUICK_BLOCK_LIMIT,
            });
      for (const block of raw) {
        if (!seedPathSet.has(block.path)) continue;
        const key = `${block.path}\0${block.heading}\0${block.lines[0]}-${block.lines[1]}`;
        const existing = rawByKey.get(key);
        if (!existing || block.similarity > existing.similarity) {
          rawByKey.set(key, {
            path: block.path,
            heading: block.heading,
            lines: block.lines,
            similarity: block.similarity,
          });
        }
      }
    }
    for (const block of rawByKey.values()) {
      const bucket = blocksByPath.get(block.path) ?? [];
      bucket.push({
        heading: block.heading,
        lines: block.lines,
        similarity: block.similarity,
      });
      blocksByPath.set(block.path, bucket);
    }
    for (const bucket of blocksByPath.values()) {
      bucket.sort((a, b) => b.similarity - a.similarity || a.lines[0] - b.lines[0]);
    }

    // Step 4b: per-seed backfill across query vectors — keep the single best
    // block over all queries for each starved seed. Blocks are empty only
    // when the note has no block embeddings at all.
    for (const seedPath of seedPaths) {
      if (blocksByPath.get(seedPath)?.length) continue;
      const source = sources.get(seedPath);
      if (!source) continue;
      let best: BlockMatch | undefined;
      for (const { queryVector } of perQueryOutputs) {
        const [hit] = searchEngine
          .findBlockNeighbors({ queryVector, sources: [source], threshold: 0, limit: 1 })
          .filter((b) => b.path === seedPath);
        if (hit && (!best || hit.similarity > best.similarity)) {
          best = { heading: hit.heading, lines: hit.lines, similarity: hit.similarity };
        }
      }
      if (best) blocksByPath.set(seedPath, [best]);
    }
  }

  // Step 5: per-seed expansion (deep only)
  let relatedByPath = new Map<string, RelatedNote[]>();
  if (expansion && expansionLimit > 0 && seeds.length > 0) {
    relatedByPath = computeRelatedPerSeed({
      seedPaths,
      sources,
      searchEngine,
      floor: expansionFloor,
      perSeedLimit: expansionLimit,
    });
  }

  // Step 6: assemble tree
  const results: NoteResultNode[] = seeds.map((seed) => ({
    path: seed.path,
    similarity: seed.similarity,
    matched_queries: seed.matched_queries,
    blocks: blocksByPath.get(seed.path) ?? [],
    related: relatedByPath.get(seed.path) ?? [],
  }));

  return { results, truncated, per_query_hits, per_query_fallback };
}
