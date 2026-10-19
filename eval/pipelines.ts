import type { ICorpusReader } from '../src/lib/obsidian/corpus/corpus.js';
import type { ILexicalReader } from '../src/lib/obsidian/lexical/index.js';
import { FsVaultReader } from '../src/lib/obsidian/vault-reader.js';
import { loadVaultScope } from '../src/lib/obsidian/vault-scope-config.js';
import { WikilinkGraphIndex } from '../src/lib/obsidian/wikilink-graph.js';
import type { SimilarityDefaults } from '../src/lib/model-profiles.js';
import { EFFORT_PROFILES, LEXICAL_PER_NOTE_CAP } from '../src/modules/semantic/effort-profiles.js';
import { EXPANSION_WEIGHT } from '../src/modules/semantic/rank-fusion.js';
import { createStandaloneLexicalReader } from '../src/modules/semantic/lexical/index.js';
import { runRetrievalPipeline } from '../src/modules/semantic/retrieval-pipeline.js';

export type PipelineId = 'semantic' | 'fused';
export type EmbedFn = (text: string) => Promise<number[]>;

export const EVAL_TOP_K = 10;

/**
 * Every knob in effect, echoed into the report's `config` (design D5/D7): a
 * run with different knobs must be distinguishable. Query-side thresholds are
 * 0 — eval counts positions. The expansion floor is the profile's own default,
 * so `fused` stays the production pipeline for that profile (design D12).
 * The pool numbers are read from the deep effort profile `runRetrievalPipeline`
 * itself reads, so the record cannot drift from the run.
 */
export function evalConfig(similarity: SimilarityDefaults) {
  const deep = EFFORT_PROFILES.deep;
  return {
    top_k: EVAL_TOP_K,
    semantic_threshold: 0,
    semantic_pool: deep.semanticPool,
    expansion_limit: deep.expansionLimit,
    expansion_floor: similarity.expansionFloor,
    lexical_note_cap: deep.lexicalNoteCap,
    lexical_per_note_cap: LEXICAL_PER_NOTE_CAP,
    expansion_weight: EXPANSION_WEIGHT,
    k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
  } as const;
}

export interface FusedContext {
  lexical: ILexicalReader;
}

export async function createFusedContext(vaultRoot: string): Promise<FusedContext> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const graph = new WikilinkGraphIndex({ reader });
  await graph.ensureFresh();
  return { lexical: createStandaloneLexicalReader({ vaultRoot, reader, graph }) };
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
  // The production pipeline itself (design D7): deep effort with an explicit
  // threshold 0 and the profile's expansion floor, the lexical reader over the
  // real wikilink graph for its backlink tie-break, the merged cap at top-k.
  // The existence filter admits every path: eval measures ranking over the
  // corpus as loaded, not a vault's deletions since.
  const config = evalConfig(similarity);
  const { candidates, semantic } = await runRetrievalPipeline(
    {
      queries: [query],
      effort: 'deep',
      semantic: true,
      threshold: config.semantic_threshold,
      expansionFloor: config.expansion_floor,
      cap: config.top_k,
    },
    {
      corpus,
      lexical: context.lexical,
      filterExisting: (paths) => Promise.resolve(new Set(paths)),
      embeddingProvider: {
        initialize: () => Promise.resolve(),
        embedQuery: () => Promise.resolve(queryVector),
      },
      similarity,
    },
  );
  // The pipeline degrades a failed semantic leg to lexical-only; a measurement
  // must fail instead of reporting a lexical-only run as fused.
  if (semantic.status === 'failed') throw semantic.error;
  return candidates.map((c) => ({ path: c.path, score: c.score }));
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
