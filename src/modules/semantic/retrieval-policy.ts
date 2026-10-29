import type { CorpusAnchor, ICorpusReader, INoteHit } from '../../lib/obsidian/corpus/corpus.js';
import type {
  BlockMatch,
  QueryEmbedder,
  NoteResultNode,
  RelatedNote,
  SearchMode,
  SearchResult,
} from './types.js';

import { EFFORT_PROFILES } from './effort-profiles.js';
import type { EffortProfile } from './effort-profiles.js';
import type { SimilarityDefaults } from '../../lib/model-profiles.js';

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

// Per-seed expansion. Each seed gets its own sorted, capped list of neighbours,
// all seeds in one corpus read. No global dedup — the same path may appear in
// multiple seeds' related lists (with potentially different
// expansion_similarity values), by design. Excluding every seed before the
// per-seed limit returns exactly what fetching `limit + seeds` and dropping
// the seeds afterwards did.
async function computeRelatedPerSeed(args: {
  seedPaths: string[];
  corpus: ICorpusReader;
  allowed: readonly string[] | undefined;
  floor: number;
  perSeedLimit: number;
}): Promise<Map<string, RelatedNote[]>> {
  const { seedPaths, corpus, allowed, floor, perSeedLimit } = args;
  const lists = await corpus.nearest(
    seedPaths.map((path) => ({ path })),
    { threshold: floor, limit: perSeedLimit, exclude: seedPaths, allowed },
  );
  // A seed without a vector of its own (null) has no neighbours to offer.
  return new Map(
    seedPaths.map((seedPath, i) => [
      seedPath,
      (lists[i] ?? []).map((n) => ({ path: n.path, expansion_similarity: n.similarity })),
    ]),
  );
}

export interface RetrievalInput {
  queries: string[];
  mode: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  expansionFloor?: number;
  /** The corpus every step reads, one call per step for all queries (design D13). */
  corpus: ICorpusReader;
  /** When present, candidate notes are restricted to these paths. */
  allowed?: readonly string[];
  embeddingProvider: QueryEmbedder;
  /** The active profile's defaults — every implicit threshold comes from here. */
  similarity: SimilarityDefaults;
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
  const { queries, mode, corpus, allowed, embeddingProvider } = input;

  const modeConfig = MODE_DEFAULTS[mode];
  const explicitThreshold = input.threshold !== undefined;
  const threshold = input.threshold ?? input.similarity[mode];
  const expansion = input.expansion ?? modeConfig.expansion;
  const expansionLimit = input.expansionLimit ?? modeConfig.expansionLimit;
  const expansionFloor = input.expansionFloor ?? input.similarity.expansionFloor;
  const limit = input.limit ?? modeConfig.limit;

  // Step 1: embed every query, then retrieve every query's seeds in one corpus
  // read (no expansion here). Request one extra hit beyond `limit` per query
  // so a per-query pool overflow is observable, then immediately slice back
  // down to `limit` — `neighbors` (and therefore `per_query_hits` and the
  // merge step below) keep exactly the same limit-bounded semantics as before
  // the over-fetch; `overflow` is the only new signal carried out of this step.
  const queryVectors = await Promise.all(
    queries.map((query) => embeddingProvider.embedQuery(query)),
  );
  const anchors: CorpusAnchor[] = queryVectors.map((vector) => ({ vector }));
  const hitsByQuery: INoteHit[][] = (
    await corpus.nearest(anchors, { threshold, limit: limit + 1, allowed })
  ).map((hits) => hits ?? []);
  // Step 2 (per query): fallback threshold — default thresholds only, and only
  // under a profile that defines one; one read for every query left empty. An
  // explicit threshold that filters everything, or a profile without a
  // fallback, returns an honest zero.
  const fallbackByQuery = queries.map(() => false);
  const emptyQueries = hitsByQuery.flatMap((hits, i) => (hits.length === 0 ? [i] : []));
  const { fallback } = input.similarity;
  if (
    emptyQueries.length > 0 &&
    !explicitThreshold &&
    fallback !== undefined &&
    threshold > fallback
  ) {
    const retried = await corpus.nearest(
      emptyQueries.map((i) => anchors[i]),
      { threshold: fallback, limit: limit + 1, allowed },
    );
    emptyQueries.forEach((queryIndex, k) => {
      const hits = retried[k] ?? [];
      hitsByQuery[queryIndex] = hits;
      fallbackByQuery[queryIndex] = hits.length > 0;
    });
  }
  const perQueryOutputs = queries.map((query, i) => {
    const hits = hitsByQuery[i];
    return {
      query,
      neighbors: hits.slice(0, limit),
      overflow: hits.length > limit,
      fallback: fallbackByQuery[i],
    };
  });

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

  // Step 4: block search for every query in one read, scoped to seed notes;
  // merge by block-key keeping max similarity. Deep filters at the profile's
  // block floor, never at a note floor, so a raised note floor cannot thin it.
  const blocksByPath = new Map<string, BlockMatch[]>();
  if (seeds.length > 0) {
    const rawByQuery = await corpus.nearestBlocks(
      anchors,
      mode === 'deep'
        ? { paths: seedPaths, threshold: input.similarity.blockFloor, limit }
        : { paths: seedPaths, threshold: 0, limit: QUICK_BLOCK_LIMIT },
    );
    const rawByKey = new Map<string, BlockMatch & { path: string }>();
    for (const raw of rawByQuery) {
      for (const block of raw ?? []) {
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

    // Step 4b: per-seed backfill across query vectors — one read per starved
    // seed carrying every query vector, keeping the single best block over
    // all queries (the first query wins a tie). Blocks are empty only when
    // the note has no block embeddings at all.
    const starved = seedPaths.filter((seedPath) => !blocksByPath.get(seedPath)?.length);
    const backfills = await Promise.all(
      starved.map((seedPath) =>
        corpus.nearestBlocks(anchors, { paths: [seedPath], threshold: 0, limit: 1 }),
      ),
    );
    starved.forEach((seedPath, i) => {
      let best: BlockMatch | undefined;
      for (const hits of backfills[i]) {
        const [hit] = (hits ?? []).filter((b) => b.path === seedPath);
        if (hit && (!best || hit.similarity > best.similarity)) {
          best = { heading: hit.heading, lines: hit.lines, similarity: hit.similarity };
        }
      }
      if (best) blocksByPath.set(seedPath, [best]);
    });
  }

  // Step 5: per-seed expansion (deep only)
  let relatedByPath = new Map<string, RelatedNote[]>();
  if (expansion && expansionLimit > 0 && seeds.length > 0) {
    relatedByPath = await computeRelatedPerSeed({
      seedPaths,
      corpus,
      allowed,
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
