import type {
  BlockSearchResult,
  EmbeddingProvider,
  MultiBlockSearchResult,
  MultiSearchResult,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
} from './types.js';

const FALLBACK_THRESHOLD = 0.3;
const QUICK_BLOCK_LIMIT = 5;

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

export interface RetrievalInput {
  query: string;
  mode: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
}

export interface RetrievalOutput {
  results: SearchResult[];
  blockResults?: BlockSearchResult[];
}

// Helper: post-cap expansion. Used by both single- and multi-query.
function computeExpansion(args: {
  seeds: { path: string; similarity: number }[];
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  threshold: number;
  perSeedLimit: number;
  totalLimit: number;
}): SearchResult[] {
  const { seeds, sources, searchEngine, threshold, perSeedLimit, totalLimit } = args;
  const seedPaths = new Set(seeds.map((s) => s.path));
  const bestByPath = new Map<string, number>();

  for (const seed of seeds) {
    const source = sources.get(seed.path);
    if (!source || source.embedding.length === 0) continue;
    const neighbors = searchEngine.findNeighbors({
      queryVector: source.embedding,
      sources: sources.values(),
      threshold,
      limit: perSeedLimit,
    });
    for (const n of neighbors) {
      if (seedPaths.has(n.path)) continue;
      const cur = bestByPath.get(n.path);
      if (cur === undefined || n.similarity > cur) {
        bestByPath.set(n.path, n.similarity);
      }
    }
  }

  return [...bestByPath.entries()]
    .map(([path, similarity]) => ({ path, similarity, via_expansion: true as const }))
    .sort((a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path))
    .slice(0, totalLimit);
}

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { query, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];

  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: Vector search
  const queryVector = await embeddingProvider.embed(query);

  let vectorResults: SearchResult[] = searchEngine.findNeighbors({
    queryVector,
    sources: sources.values(),
    threshold,
    limit,
  });

  // Step 2: Fallback — lower threshold if no results
  if (vectorResults.length === 0 && threshold > FALLBACK_THRESHOLD) {
    vectorResults = searchEngine.findNeighbors({
      queryVector,
      sources: sources.values(),
      threshold: FALLBACK_THRESHOLD,
      limit,
    });
  }

  // Step 3: Block-level search
  let blockResults: BlockSearchResult[] | undefined;
  if (mode === 'deep') {
    blockResults = searchEngine.findBlockNeighbors({
      queryVector,
      sources: sources.values(),
      threshold,
      limit,
    });
  } else if (vectorResults.length > 0) {
    const matchedPaths = new Set(vectorResults.map((r) => r.path));
    const matchedSources = [...sources.values()].filter((s) => matchedPaths.has(s.path));
    blockResults = searchEngine.findBlockNeighbors({
      queryVector,
      sources: matchedSources,
      threshold: 0,
      limit: QUICK_BLOCK_LIMIT,
    });
  }

  // Step 4: Cap seeds to `limit`
  const cappedSeeds = vectorResults.slice(0, limit);

  // Step 5: Post-cap expansion (deep only)
  let expansionResults: SearchResult[] = [];
  if (expansion && expansionLimit > 0 && cappedSeeds.length > 0) {
    expansionResults = computeExpansion({
      seeds: cappedSeeds,
      sources,
      searchEngine,
      threshold,
      perSeedLimit: limit,
      totalLimit: expansionLimit,
    });
  }

  return {
    results: [...cappedSeeds, ...expansionResults],
    ...(blockResults !== undefined ? { blockResults } : {}),
  };
}

export interface MultiRetrievalInput extends Omit<RetrievalInput, 'query'> {
  queries: string[];
  limit?: number;
}

export interface MultiRetrievalOutput {
  results: MultiSearchResult[];
  blockResults?: MultiBlockSearchResult[];
  truncated: boolean;
}

function mergeNoteResults(
  perQuery: Array<{ query: string; results: SearchResult[] }>,
): MultiSearchResult[] {
  const byPath = new Map<string, MultiSearchResult>();
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
      existing.matched_queries ??= [];
      if (!existing.matched_queries.includes(query)) {
        existing.matched_queries.push(query);
      }
    }
  }
  return [...byPath.values()].sort(
    (a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path),
  );
}

function mergeBlockResults(
  perQuery: Array<{ query: string; blocks: BlockSearchResult[] }>,
): MultiBlockSearchResult[] {
  const byKey = new Map<string, MultiBlockSearchResult>();
  for (const { query, blocks } of perQuery) {
    for (const block of blocks) {
      const key = `${block.path}\u0000${block.heading}\u0000${block.lines[0]}-${block.lines[1]}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          path: block.path,
          heading: block.heading,
          lines: block.lines,
          similarity: block.similarity,
          matched_queries: [query],
        });
        continue;
      }
      if (block.similarity > existing.similarity) {
        existing.similarity = block.similarity;
      }
      if (!existing.matched_queries.includes(query)) {
        existing.matched_queries.push(query);
      }
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.similarity - a.similarity || a.path.localeCompare(b.path),
  );
}

export async function executeMultiRetrieval(
  input: MultiRetrievalInput,
): Promise<MultiRetrievalOutput> {
  const { queries, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: per-query embed + retrieval (no expansion here)
  const perQueryOutputs = await Promise.all(
    queries.map(async (query) => {
      const queryVector = await embeddingProvider.embed(query);
      let neighbors = searchEngine.findNeighbors({
        queryVector,
        sources: sources.values(),
        threshold,
        limit,
      });
      if (neighbors.length === 0 && threshold > FALLBACK_THRESHOLD) {
        neighbors = searchEngine.findNeighbors({
          queryVector,
          sources: sources.values(),
          threshold: FALLBACK_THRESHOLD,
          limit,
        });
      }
      let blocks: BlockSearchResult[] = [];
      if (mode === 'deep') {
        blocks = searchEngine.findBlockNeighbors({
          queryVector,
          sources: sources.values(),
          threshold,
          limit,
        });
      } else if (neighbors.length > 0) {
        const matched = new Set(neighbors.map((r) => r.path));
        const matchedSources = [...sources.values()].filter((s) => matched.has(s.path));
        blocks = searchEngine.findBlockNeighbors({
          queryVector,
          sources: matchedSources,
          threshold: 0,
          limit: QUICK_BLOCK_LIMIT,
        });
      }
      return { query, neighbors, blocks };
    }),
  );

  // Step 2: merge
  const mergedNotes = mergeNoteResults(
    perQueryOutputs.map(({ query, neighbors }) => ({ query, results: neighbors })),
  );
  const anyBlocks = perQueryOutputs.some(({ blocks }) => blocks.length > 0);
  const mergedBlocks = anyBlocks
    ? mergeBlockResults(perQueryOutputs.map(({ query, blocks }) => ({ query, blocks })))
    : undefined;

  // Step 3: cap to `limit` (final, independent of N)
  const truncated = mergedNotes.length > limit || (mergedBlocks?.length ?? 0) > limit;
  const cappedNotes = mergedNotes.slice(0, limit);
  const cappedBlocks = mergedBlocks ? mergedBlocks.slice(0, limit) : undefined;

  // Step 4: post-cap expansion (deep only)
  let expansionResults: MultiSearchResult[] = [];
  if (expansion && expansionLimit > 0 && cappedNotes.length > 0) {
    const seeds = cappedNotes.map((n) => ({ path: n.path, similarity: n.similarity }));
    const raw = computeExpansion({
      seeds,
      sources,
      searchEngine,
      threshold,
      perSeedLimit: limit,
      totalLimit: expansionLimit,
    });
    expansionResults = raw.map((r) => ({
      path: r.path,
      similarity: r.similarity,
      via_expansion: true as const,
    }));
  }

  return {
    results: [...cappedNotes, ...expansionResults],
    ...(cappedBlocks !== undefined ? { blockResults: cappedBlocks } : {}),
    truncated,
  };
}
