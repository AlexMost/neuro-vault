import type { ICorpusReader } from '../src/lib/obsidian/corpus/corpus.js';
import { LexicalIndex } from '../src/lib/obsidian/lexical/index.js';
import { FsVaultReader } from '../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../src/lib/obsidian/vault-scope-config.js';
import { WikilinkGraphIndex } from '../src/lib/obsidian/wikilink-graph.js';
import type { SimilarityDefaults } from '../src/lib/model-profiles.js';
import {
  EXPANSION_WEIGHT,
  flattenExpansion,
  fuseRanks,
} from '../src/modules/semantic/rank-fusion.js';
import { executeRetrieval } from '../src/modules/semantic/retrieval-policy.js';

export type PipelineId = 'semantic' | 'fused';
export type EmbedFn = (text: string) => Promise<number[]>;

export const EVAL_TOP_K = 10;

/**
 * Every knob in effect, echoed into the report's `config` (design D5/D7): a
 * run with different knobs must be distinguishable. Query-side thresholds are
 * 0 — eval counts positions. The expansion floor is the profile's own default,
 * so `fused` stays the production pipeline for that profile (design D12).
 * Everything else mirrors production deep effort.
 */
export function evalConfig(similarity: SimilarityDefaults) {
  return {
    top_k: EVAL_TOP_K,
    semantic_threshold: 0,
    semantic_pool: 8,
    expansion_limit: 3,
    expansion_floor: similarity.expansionFloor,
    lexical_note_cap: 10,
    lexical_per_note_cap: 3,
    expansion_weight: EXPANSION_WEIGHT,
    k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
  } as const;
}

export interface FusedContext {
  lexical: LexicalIndex;
  graph: WikilinkGraphIndex;
}

export async function createFusedContext(vaultRoot: string): Promise<FusedContext> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const graph = new WikilinkGraphIndex({ reader });
  await graph.ensureFresh();
  return { lexical: new LexicalIndex({ vaultRoot, reader }), graph };
}

export interface RankedPath {
  path: string;
  score: number;
}

/**
 * Best cosine between the query and any relevant note, ranked or not — the
 * evidence a threshold calibration needs for notes the top list never reached.
 */
export async function bestRelevantSimilarity(
  queryVector: number[],
  relevant: string[],
  corpus: ICorpusReader,
): Promise<number | null> {
  const [hits] = await corpus.nearest([{ vector: queryVector }], {
    threshold: -1,
    limit: 1,
    allowed: relevant,
  });
  return hits?.[0]?.similarity ?? null;
}

async function rankSemantic(
  queryVector: number[],
  corpus: ICorpusReader,
  similarity: SimilarityDefaults,
): Promise<RankedPath[]> {
  const [hits] = await corpus.nearest([{ vector: queryVector }], {
    threshold: evalConfig(similarity).semantic_threshold,
    limit: EVAL_TOP_K,
  });
  return (hits ?? []).map((r) => ({ path: r.path, score: r.similarity }));
}

async function rankFused(
  query: string,
  queryVector: number[],
  corpus: ICorpusReader,
  context: FusedContext,
  similarity: SimilarityDefaults,
): Promise<RankedPath[]> {
  // The production legs, verbatim (design D5): executeRetrieval at deep
  // effort (pool 8, expansion on) with an explicit threshold 0, the lexical
  // index with the real wikilink graph for its backlink tie-break, then the
  // exact fusion `assembleUnified` performs — flattenExpansion + fuseRanks.
  // Every knob is passed explicitly, including the two that merely match
  // `MODE_DEFAULTS.deep` today: `config` is the report's comparability record,
  // and a silent lie there is worse than the drift it would hide.
  const config = evalConfig(similarity);
  const semantic = await executeRetrieval({
    queries: [query],
    mode: 'deep',
    limit: config.semantic_pool,
    threshold: config.semantic_threshold,
    expansionLimit: config.expansion_limit,
    expansionFloor: config.expansion_floor,
    corpus,
    embeddingProvider: {
      initialize: () => Promise.resolve(),
      embedQuery: () => Promise.resolve(queryVector),
    },
    similarity,
  });
  const lexical = await context.lexical.search({
    queries: [query],
    noteCap: config.lexical_note_cap,
    perNoteCap: config.lexical_per_note_cap,
    getBacklinkCount: (p) => context.graph.getBacklinkCount(p),
  });
  const expansion = flattenExpansion(semantic.results);
  return fuseRanks({
    sources: {
      semantic: semantic.results.map((n) => n.path),
      lexical: lexical.notes.map((n) => n.path),
      expansion: expansion.map((e) => e.path),
    },
    totalNotes: lexical.totalNotes,
  })
    .slice(0, EVAL_TOP_K)
    .map((c) => ({ path: c.path, score: c.score }));
}

export async function rankQuery(args: {
  pipeline: PipelineId;
  /** The query text — the lexical leg of `fused` searches it; `semantic` ignores it. */
  query: string;
  /** The query embedded once by the caller, so both pipelines rank the same vector. */
  queryVector: number[];
  /** The vault's own corpus, loaded in-process (design D15). */
  corpus: ICorpusReader;
  fusedContext?: FusedContext;
  similarity: SimilarityDefaults;
}): Promise<RankedPath[]> {
  if (args.pipeline === 'semantic') {
    return rankSemantic(args.queryVector, args.corpus, args.similarity);
  }
  if (!args.fusedContext) {
    throw new Error('fused pipeline requires a FusedContext');
  }
  return rankFused(args.query, args.queryVector, args.corpus, args.fusedContext, args.similarity);
}
