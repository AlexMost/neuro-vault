import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
  TextSearchProvider,
  TextSearchResult,
} from './types.js';

const FALLBACK_THRESHOLD = 0.3;
const TEXT_SEARCH_LIMIT = 10;

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
  queries: string[];
  mode: SearchMode;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  vaultPath: string;
  obsidianSearch?: TextSearchProvider;
  grepSearch?: TextSearchProvider;
}

export interface RetrievalOutput {
  results: SearchResult[];
  blockResults?: BlockSearchResult[];
  textFallbackResults?: TextSearchResult[];
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

function mergeAndDeduplicate(a: SearchResult[], b: SearchResult[]): SearchResult[] {
  return deduplicateResults([...a, ...b]);
}

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const {
    queries,
    mode,
    sources,
    embeddingProvider,
    searchEngine,
    vaultPath,
    obsidianSearch,
    grepSearch,
  } = input;

  const modeConfig = MODE_DEFAULTS[mode];

  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = modeConfig.limit;

  // Step 1: Multi-query vector search
  const allQueryVectors: Array<{ query: string; vector: number[] }> = [];
  for (const query of queries) {
    const vector = await embeddingProvider.embed(query);
    allQueryVectors.push({ query, vector });
  }

  let vectorResults: SearchResult[] = [];
  for (const { vector } of allQueryVectors) {
    const results = searchEngine.findNeighbors({
      queryVector: vector,
      sources: sources.values(),
      threshold,
      limit,
    });
    vectorResults = mergeAndDeduplicate(vectorResults, results);
  }

  // Step 2: Fallback — lower threshold if no results and threshold > FALLBACK_THRESHOLD
  if (vectorResults.length === 0 && threshold > FALLBACK_THRESHOLD) {
    const firstVector = allQueryVectors[0]!.vector;
    const fallbackResults = searchEngine.findNeighbors({
      queryVector: firstVector,
      sources: sources.values(),
      threshold: FALLBACK_THRESHOLD,
      limit,
    });
    vectorResults = fallbackResults;
  }

  // Step 3: Block-level search (deep mode only)
  let blockResults: BlockSearchResult[] | undefined;
  if (mode === 'deep') {
    const allBlockResults: BlockSearchResult[] = [];
    for (const { vector } of allQueryVectors) {
      const results = searchEngine.findBlockNeighbors({
        queryVector: vector,
        sources: sources.values(),
        threshold,
        limit,
      });
      allBlockResults.push(...results);
    }
    blockResults = allBlockResults;
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
      vectorResults = mergeAndDeduplicate(vectorResults, expansionNeighbors);
    }
  }

  // Step 5: Apply final limit
  vectorResults = vectorResults.slice(0, limit);

  // Step 6: Text fallback if no vector results
  let textFallbackResults: TextSearchResult[] | undefined;
  if (vectorResults.length === 0) {
    const firstQuery = queries[0]!;

    if (obsidianSearch) {
      const available = await obsidianSearch.isAvailable();
      if (available) {
        textFallbackResults = await obsidianSearch.search(firstQuery, vaultPath, TEXT_SEARCH_LIMIT);
      }
    }

    if (textFallbackResults === undefined && grepSearch) {
      const available = await grepSearch.isAvailable();
      if (available) {
        textFallbackResults = await grepSearch.search(firstQuery, vaultPath, TEXT_SEARCH_LIMIT);
      }
    }
  }

  return {
    results: vectorResults,
    ...(blockResults !== undefined ? { blockResults } : {}),
    ...(textFallbackResults !== undefined ? { textFallbackResults } : {}),
  };
}
