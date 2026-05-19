import type {
  BlockMatch,
  EmbeddingProvider,
  MultiNoteResultNode,
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
    for (const bucket of blocksByPath.values()) {
      bucket.sort((a, b) => b.similarity - a.similarity || a.lines[0] - b.lines[0]);
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

export interface MultiRetrievalOutput {
  results: MultiNoteResultNode[];
  truncated: boolean;
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

export async function executeMultiRetrieval(
  input: MultiRetrievalInput,
): Promise<MultiRetrievalOutput> {
  const { queries, mode, sources, embeddingProvider, searchEngine } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const threshold = input.threshold ?? modeConfig.threshold;
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: per-query embed + retrieve (no expansion here)
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
      return { query, queryVector, neighbors };
    }),
  );

  // Step 2: merge seeds across queries
  const merged = mergeNoteResults(
    perQueryOutputs.map(({ query, neighbors }) => ({ query, results: neighbors })),
  );

  // Step 3: cap to `limit`
  const truncated = merged.length > limit;
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
              threshold,
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
        const key = `${block.path} ${block.heading} ${block.lines[0]}-${block.lines[1]}`;
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
  }

  // Step 5: per-seed expansion (deep only) — reuses the same helper as executeRetrieval.
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
  const results: MultiNoteResultNode[] = seeds.map((seed) => ({
    path: seed.path,
    similarity: seed.similarity,
    matched_queries: seed.matched_queries,
    blocks: blocksByPath.get(seed.path) ?? [],
    related: relatedByPath.get(seed.path) ?? [],
  }));

  return { results, truncated };
}
