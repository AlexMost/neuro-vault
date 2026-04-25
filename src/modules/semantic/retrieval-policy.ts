import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
} from '../../types.js';

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

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const best = new Map<string, SearchResult>();
  for (const result of results) {
    const existing = best.get(result.path);
    if (!existing || result.similarity > existing.similarity) {
      best.set(result.path, result);
    }
  }
  return Array.from(best.values());
}

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const { query, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];

  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = modeConfig.limit;

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

  // Step 4: Expansion
  if (expansion && vectorResults.length > 0) {
    const topResults = vectorResults.slice(0, expansionLimit);
    for (const topResult of topResults) {
      const source = sources.get(topResult.path);
      if (!source || source.embedding.length === 0) continue;
      const expansionNeighbors = searchEngine.findNeighbors({
        queryVector: source.embedding,
        sources: sources.values(),
        threshold,
        limit,
      });
      vectorResults = deduplicateResults([...vectorResults, ...expansionNeighbors]);
    }
  }

  // Step 5: Apply final limit
  vectorResults = vectorResults.slice(0, limit);

  return {
    results: vectorResults,
    ...(blockResults !== undefined ? { blockResults } : {}),
  };
}
