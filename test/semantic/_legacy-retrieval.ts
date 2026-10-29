// The in-memory semantic leg as it ranked before it was composed over
// `ICorpusReader` (design D13), frozen as a test oracle: the parity test
// requires today's `executeRetrieval` to return exactly what this returns.
// Self-contained on purpose — it carries its own copies of the scan
// (`findNeighbors` / `findBlockNeighbors`, and `find_duplicates`' pair scan) and
// the source narrowing, so it
// outlives the snapshot, `SearchEngine` and anything else the corpus reads
// replace. Do not "fix" it to follow production: a diff against it is the
// regression it exists to catch.

import type { SimilarityDefaults } from '../../src/lib/model-profiles.js';
import { cosineSimilarity, ensureSameDimensions } from '../../src/lib/obsidian/corpus/scoring.js';
import { EFFORT_PROFILES } from '../../src/modules/semantic/effort-profiles.js';
import type { EffortProfile } from '../../src/modules/semantic/effort-profiles.js';
import type { RetrievalOutput } from '../../src/modules/semantic/retrieval-policy.js';
import type {
  BlockMatch,
  BlockSearchResult,
  DuplicatePair,
  NoteResultNode,
  QueryEmbedder,
  RelatedNote,
  SearchMode,
  SearchResult,
  SmartSource,
} from '../../src/modules/semantic/types.js';

const QUICK_BLOCK_LIMIT = 5;

interface ModeConfig {
  limit: number;
  expansion: boolean;
  expansionLimit: number;
}

function toModeConfig(profile: EffortProfile): ModeConfig {
  return {
    limit: profile.semanticPool,
    expansion: profile.expansion,
    expansionLimit: profile.expansionLimit,
  };
}

const MODE_DEFAULTS: Record<SearchMode, ModeConfig> = {
  quick: toModeConfig(EFFORT_PROFILES.quick),
  deep: toModeConfig(EFFORT_PROFILES.deep),
};

// --- the scan, as search-engine.ts ran it -----------------------------------

function compareHits(
  left: { path: string; similarity: number },
  right: { path: string; similarity: number },
): number {
  return right.similarity - left.similarity || left.path.localeCompare(right.path);
}

function findNeighbors({
  queryVector,
  sources,
  threshold,
  limit,
}: {
  queryVector: ArrayLike<number>;
  sources: Iterable<SmartSource>;
  threshold: number;
  limit?: number;
}): SearchResult[] {
  const results: SearchResult[] = [];
  for (const source of sources) {
    ensureSameDimensions(
      queryVector,
      source.embedding,
      'Query vector',
      `Source vector for ${source.path}`,
    );
    const similarity = cosineSimilarity(queryVector, source.embedding);
    if (similarity >= threshold) results.push({ path: source.path, similarity });
  }
  results.sort(compareHits);
  return typeof limit === 'number' ? results.slice(0, limit) : results;
}

function findBlockNeighbors({
  queryVector,
  sources,
  threshold,
  limit,
}: {
  queryVector: ArrayLike<number>;
  sources: Iterable<SmartSource>;
  threshold: number;
  limit?: number;
}): BlockSearchResult[] {
  const results: BlockSearchResult[] = [];
  for (const source of sources) {
    for (const block of source.blocks) {
      if (block.embedding.length === 0) continue;
      ensureSameDimensions(
        queryVector,
        block.embedding,
        'Query vector',
        `Block vector for ${block.key}`,
      );
      const similarity = cosineSimilarity(queryVector, block.embedding);
      if (similarity >= threshold) {
        results.push({ path: source.path, heading: block.heading, lines: block.lines, similarity });
      }
    }
  }
  results.sort(compareHits);
  return typeof limit === 'number' ? results.slice(0, limit) : results;
}

// --- the narrowing, as retrieval-pipeline.ts ran it --------------------------

export function legacyNarrowSources(
  sources: Map<string, SmartSource>,
  allowed: Iterable<string>,
): Map<string, SmartSource> {
  const out = new Map<string, SmartSource>();
  for (const path of allowed) {
    const src = sources.get(path);
    if (src) out.set(path, src);
  }
  return out;
}

// --- executeRetrieval, as retrieval-policy.ts ran it -------------------------

function computeRelatedPerSeed(args: {
  seedPaths: string[];
  sources: Map<string, SmartSource>;
  floor: number;
  perSeedLimit: number;
}): Map<string, RelatedNote[]> {
  const { seedPaths, sources, floor, perSeedLimit } = args;
  const seedSet = new Set(seedPaths);
  const out = new Map<string, RelatedNote[]>();
  for (const seedPath of seedPaths) {
    const source = sources.get(seedPath);
    if (!source || source.embedding.length === 0) {
      out.set(seedPath, []);
      continue;
    }
    const neighbours = findNeighbors({
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

export interface LegacyRetrievalInput {
  queries: string[];
  mode: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  expansionFloor?: number;
  /** Already narrowed to the search's allowed set (see `legacyNarrowSources`). */
  sources: Map<string, SmartSource>;
  embeddingProvider: QueryEmbedder;
  /** The frozen leg predates the optional fallback, so it is fed only profiles that carry one. */
  similarity: Required<SimilarityDefaults>;
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

export async function legacyExecuteRetrieval(
  input: LegacyRetrievalInput,
): Promise<RetrievalOutput> {
  const { queries, mode, sources, embeddingProvider } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const explicitThreshold = input.threshold !== undefined;
  const threshold = input.threshold ?? input.similarity[mode];
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const expansionFloor = input.expansionFloor ?? input.similarity.expansionFloor;
  const limit = input.limit ?? modeConfig.limit;

  const perQueryOutputs = await Promise.all(
    queries.map(async (query) => {
      const queryVector = await embeddingProvider.embedQuery(query);
      let neighbors = findNeighbors({
        queryVector,
        sources: sources.values(),
        threshold,
        limit: limit + 1,
      });
      let fallback = false;
      if (neighbors.length === 0 && !explicitThreshold && threshold > input.similarity.fallback) {
        neighbors = findNeighbors({
          queryVector,
          sources: sources.values(),
          threshold: input.similarity.fallback,
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

  const merged = mergeNoteResults(
    perQueryOutputs.map(({ query, neighbors }) => ({ query, results: neighbors })),
  );

  const mergeOverflow = merged.length > limit;
  const anyQueryOverflow = perQueryOutputs.some((o) => o.overflow);
  const truncated = mergeOverflow || anyQueryOverflow;
  const seeds = merged.slice(0, limit);
  const seedPaths = seeds.map((s) => s.path);
  const seedPathSet = new Set(seedPaths);

  const blocksByPath = new Map<string, BlockMatch[]>();
  if (seeds.length > 0) {
    const seedSources = [...sources.values()].filter((s) => seedPathSet.has(s.path));
    const rawByKey = new Map<string, BlockMatch & { path: string }>();
    for (const { queryVector } of perQueryOutputs) {
      const raw =
        mode === 'deep'
          ? findBlockNeighbors({
              queryVector,
              sources: seedSources,
              threshold: input.similarity.deep,
              limit,
            })
          : findBlockNeighbors({
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

    for (const seedPath of seedPaths) {
      if (blocksByPath.get(seedPath)?.length) continue;
      const source = sources.get(seedPath);
      if (!source) continue;
      let best: BlockMatch | undefined;
      for (const { queryVector } of perQueryOutputs) {
        const [hit] = findBlockNeighbors({
          queryVector,
          sources: [source],
          threshold: 0,
          limit: 1,
        }).filter((b) => b.path === seedPath);
        if (hit && (!best || hit.similarity > best.similarity)) {
          best = { heading: hit.heading, lines: hit.lines, similarity: hit.similarity };
        }
      }
      if (best) blocksByPath.set(seedPath, [best]);
    }
  }

  let relatedByPath = new Map<string, RelatedNote[]>();
  if (expansion && expansionLimit > 0 && seeds.length > 0) {
    relatedByPath = computeRelatedPerSeed({
      seedPaths,
      sources,
      floor: expansionFloor,
      perSeedLimit: expansionLimit,
    });
  }

  const results: NoteResultNode[] = seeds.map((seed) => ({
    path: seed.path,
    similarity: seed.similarity,
    matched_queries: seed.matched_queries,
    blocks: blocksByPath.get(seed.path) ?? [],
    related: relatedByPath.get(seed.path) ?? [],
  }));

  return { results, truncated, per_query_hits, per_query_fallback };
}

// --- the scans, for the oracles of the tools composed over the reads ---------

/** The note scan, as `get_similar_notes` and the ranking tests compared against it. */
export { findNeighbors as legacyFindNeighbors, findBlockNeighbors as legacyFindBlockNeighbors };

/** `find_duplicates` as search-engine.ts ran it: every pair, once, by similarity then path. */
export function legacyFindDuplicates({
  sources,
  threshold,
}: {
  sources: Iterable<SmartSource>;
  threshold: number;
}): DuplicatePair[] {
  const sourceList = [...sources];
  const duplicates: DuplicatePair[] = [];
  for (let leftIndex = 0; leftIndex < sourceList.length; leftIndex += 1) {
    const left = sourceList[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < sourceList.length; rightIndex += 1) {
      const right = sourceList[rightIndex];
      ensureSameDimensions(
        left.embedding,
        right.embedding,
        `Source vector for ${left.path}`,
        `Source vector for ${right.path}`,
      );
      const similarity = cosineSimilarity(left.embedding, right.embedding);
      if (similarity >= threshold) {
        const ordered = left.path.localeCompare(right.path) <= 0;
        duplicates.push({
          note_a: ordered ? left.path : right.path,
          note_b: ordered ? right.path : left.path,
          similarity,
        });
      }
    }
  }
  duplicates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.note_a.localeCompare(right.note_a) ||
      left.note_b.localeCompare(right.note_b),
  );
  return duplicates;
}
