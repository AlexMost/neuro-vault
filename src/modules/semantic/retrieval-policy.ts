import type {
  BlockMatch,
  BlockSearchResult,
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
  results: NoteResultNode[];
}

// Per-seed expansion. Each seed gets its own sorted, capped list of neighbours.
// No global dedup — the same path may appear in multiple seeds' related lists
// (with potentially different expansion_similarity values), by design.
function computeRelatedPerSeed(args: {
  seedPaths: string[];
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  threshold: number;
  perSeedLimit: number;
}): Map<string, RelatedNote[]> {
  const { seedPaths, sources, searchEngine, threshold, perSeedLimit } = args;
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
      threshold,
      limit: perSeedLimit,
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

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { query, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: embed + vector search
  const queryVector = await embeddingProvider.embed(query);
  let vectorResults: SearchResult[] = searchEngine.findNeighbors({
    queryVector,
    sources: sources.values(),
    threshold,
    limit,
  });

  // Step 2: fallback threshold
  if (vectorResults.length === 0 && threshold > FALLBACK_THRESHOLD) {
    vectorResults = searchEngine.findNeighbors({
      queryVector,
      sources: sources.values(),
      threshold: FALLBACK_THRESHOLD,
      limit,
    });
  }

  // Step 3: cap seeds to `limit`
  const seeds = vectorResults.slice(0, limit);
  const seedPaths = seeds.map((s) => s.path);
  const seedPathSet = new Set(seedPaths);

  // Step 4: block search, always scoped to seed notes (orphan blocks dropped)
  const blocksByPath = new Map<string, BlockMatch[]>();
  if (seeds.length > 0) {
    const seedSources = [...sources.values()].filter((s) => seedPathSet.has(s.path));
    const rawBlocks =
      mode === 'deep'
        ? searchEngine.findBlockNeighbors({
            queryVector,
            sources: seedSources,
            threshold,
            limit,
          })
        : searchEngine.findBlockNeighbors({
            queryVector,
            sources: seedSources,
            threshold: 0,
            limit: QUICK_BLOCK_LIMIT,
          });
    for (const block of rawBlocks) {
      if (!seedPathSet.has(block.path)) continue;
      const bucket = blocksByPath.get(block.path) ?? [];
      bucket.push({ heading: block.heading, lines: block.lines, similarity: block.similarity });
      blocksByPath.set(block.path, bucket);
    }
  }

  // Step 5: per-seed expansion (deep only)
  let relatedByPath = new Map<string, RelatedNote[]>();
  if (expansion && expansionLimit > 0 && seeds.length > 0) {
    relatedByPath = computeRelatedPerSeed({
      seedPaths,
      sources,
      searchEngine,
      threshold,
      perSeedLimit: expansionLimit,
    });
  }

  // Step 6: assemble tree
  const results: NoteResultNode[] = seeds.map((seed) => ({
    path: seed.path,
    similarity: seed.similarity,
    blocks: blocksByPath.get(seed.path) ?? [],
    related: relatedByPath.get(seed.path) ?? [],
  }));

  return { results };
}

export interface MultiRetrievalInput extends Omit<RetrievalInput, 'query'> {
  queries: string[];
  limit?: number;
}

// Task 3 will rewrite this entire block (MultiRetrievalOutput through executeMultiRetrieval).
// The types MultiSearchResult, MultiBlockSearchResult, and computeExpansion no longer exist
// after Task 1; lint is disabled here to keep the diff small for review.
/* eslint-disable no-undef */
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
/* eslint-enable no-undef */
