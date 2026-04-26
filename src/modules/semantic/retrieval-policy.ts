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
const HARD_MERGE_CAP = 50;

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
        byKey.set(key, { ...block, matched_queries: [query] });
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

  const perQueryOutputs = await Promise.all(
    queries.map(async (query) => {
      const output = await executeRetrieval({
        query,
        mode,
        threshold: input.threshold,
        expansion: input.expansion,
        expansionLimit: input.expansionLimit,
        sources,
        embeddingProvider,
        searchEngine,
      });
      return { query, output };
    }),
  );

  const mergedNotes = mergeNoteResults(
    perQueryOutputs.map(({ query, output }) => ({ query, results: output.results })),
  );

  const anyBlocks = perQueryOutputs.some(({ output }) => output.blockResults !== undefined);
  const mergedBlocks = anyBlocks
    ? mergeBlockResults(
        perQueryOutputs.map(({ query, output }) => ({
          query,
          blocks: output.blockResults ?? [],
        })),
      )
    : undefined;

  const perQueryLimit = input.limit ?? MODE_DEFAULTS[mode].limit;
  const cap = Math.min(perQueryLimit * queries.length, HARD_MERGE_CAP);

  const truncated = mergedNotes.length > cap;
  const cappedNotes = mergedNotes.slice(0, cap);
  const cappedBlocks = mergedBlocks ? mergedBlocks.slice(0, cap) : undefined;

  return {
    results: cappedNotes,
    ...(cappedBlocks !== undefined ? { blockResults: cappedBlocks } : {}),
    truncated,
  };
}
