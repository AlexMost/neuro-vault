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
import type { SearchEffort } from '../src/modules/semantic/types.js';

export const PIPELINES = ['semantic', 'fused', 'lexical'] as const;
export type PipelineId = (typeof PIPELINES)[number];
export type EmbedFn = (text: string) => Promise<number[]>;

/**
 * - `positional`: every query-side floor at 0, deep effort, top-10 — where relevant notes
 *   rank, for ranking comparisons.
 * - `production`: the profile's default floors (and its one-shot fallback), the effort's own
 *   pools and merged cap — the list an agent actually receives.
 */
export const RUN_MODES = ['positional', 'production'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** One run's shape. A positional run is always deep. */
export interface RunShape {
  run: RunMode;
  effort: SearchEffort;
}

export const POSITIONAL: RunShape = { run: 'positional', effort: 'deep' };

export const EVAL_TOP_K = 10;

/** A leg that surfaced a returned note — `search_notes`' `found_in`, without the lexical kind. */
export type Leg = 'semantic' | 'lexical' | 'expansion';

/**
 * Every knob in effect, echoed into the report's `config` (design D5/D7): a
 * run with different knobs must be distinguishable. A positional run zeroes the
 * query-side thresholds — it counts positions; a production run leaves them to
 * the profile, as `search_notes` does. The expansion floor is the profile's own
 * default either way, so `fused` stays the production pipeline for that profile
 * (design D12). The pool numbers are read from the effort profile
 * `runRetrievalPipeline` itself reads, so they cannot drift from the run.
 */
export function evalConfig(similarity: SimilarityDefaults, shape: RunShape = POSITIONAL) {
  const profile = EFFORT_PROFILES[shape.effort];
  const positional = shape.run === 'positional';
  return {
    run: shape.run,
    effort: shape.effort,
    top_k: positional ? EVAL_TOP_K : profile.mergedCap,
    semantic_threshold: positional ? 0 : similarity[shape.effort],
    /**
     * The one-shot retry production makes when a default threshold finds nothing; null when off,
     * including under a profile that defines no fallback.
     */
    fallback_threshold: positional ? null : (similarity.fallback ?? null),
    semantic_pool: profile.semanticPool,
    expansion: profile.expansion,
    expansion_limit: profile.expansionLimit,
    expansion_floor: similarity.expansionFloor,
    /** The deep block-evidence floor; blocks are not scored, so it is a record of the run. */
    block_floor: similarity.blockFloor,
    lexical_note_cap: profile.lexicalNoteCap,
    lexical_per_note_cap: LEXICAL_PER_NOTE_CAP,
    expansion_weight: EXPANSION_WEIGHT,
    k_policy: 'round(sqrt(totalNotes)) clamped 5..60',
  } as const;
}

export interface LexicalContext {
  lexical: ILexicalReader;
}

export async function createLexicalContext(vaultRoot: string): Promise<LexicalContext> {
  const scope = await loadVaultScope(vaultRoot);
  const reader = new FsVaultReader({ vaultRoot, scope });
  const graph = new WikilinkGraphIndex({ reader });
  await graph.ensureFresh();
  return { lexical: createStandaloneLexicalReader({ vaultRoot, reader, graph }) };
}

export interface RankedPath {
  path: string;
  score: number;
  /** The legs that surfaced it; absent on `semantic`, which has one leg by construction. */
  found_in?: Leg[];
}

/**
 * Best cosine between any of the call's query vectors and any relevant note,
 * ranked or not — the evidence a threshold calibration needs for notes the top
 * list never reached. Null when no relevant note has a vector (always, for a
 * control entry).
 */
export async function bestRelevantSimilarity(
  queryVectors: number[][],
  relevant: string[],
  corpus: ICorpusReader,
): Promise<number | null> {
  if (relevant.length === 0) return null;
  const lists = await corpus.nearest(
    queryVectors.map((vector) => ({ vector })),
    { threshold: -1, limit: 1, allowed: relevant },
  );
  const best = lists.flatMap((hits) => (hits?.[0] ? [hits[0].similarity] : []));
  return best.length === 0 ? null : Math.max(...best);
}

async function rankSemantic(queryVector: number[], corpus: ICorpusReader): Promise<RankedPath[]> {
  const [hits] = await corpus.nearest([{ vector: queryVector }], {
    threshold: 0,
    limit: EVAL_TOP_K,
  });
  return (hits ?? []).map((r) => ({ path: r.path, score: r.similarity }));
}

async function rankRetrieval(args: {
  semantic: boolean;
  queries: string[];
  vectors: ReadonlyMap<string, number[]>;
  corpus: ICorpusReader;
  context: LexicalContext;
  similarity: SimilarityDefaults;
  shape: RunShape;
}): Promise<RankedPath[]> {
  // The production pipeline itself (design D7). A positional run passes threshold 0, the
  // profile's expansion floor and the top-k cap explicitly; a production run passes none of
  // them, so the pipeline applies the profile's defaults, its fallback retry and the
  // effort's merged cap exactly as `search_notes` does. `semantic: false` is the
  // `mode: lexical` path. The existence filter admits every path: eval measures ranking
  // over the corpus as loaded (stale paths are counted in the report's coverage).
  const config = evalConfig(args.similarity, args.shape);
  const positional = args.shape.run === 'positional';
  const { candidates, semantic } = await runRetrievalPipeline(
    {
      queries: args.queries,
      effort: args.shape.effort,
      semantic: args.semantic,
      ...(positional
        ? {
            threshold: config.semantic_threshold,
            expansionFloor: config.expansion_floor,
            cap: config.top_k,
          }
        : {}),
    },
    {
      corpus: args.corpus,
      lexical: args.context.lexical,
      filterExisting: (paths) => Promise.resolve(new Set(paths)),
      embeddingProvider: {
        initialize: () => Promise.resolve(),
        // Every string was embedded once by the caller; a miss is a harness bug.
        embedQuery: (text) => {
          const vector = args.vectors.get(text);
          return vector
            ? Promise.resolve(vector)
            : Promise.reject(new Error(`eval: no vector for query "${text}"`));
        },
      },
      similarity: args.similarity,
    },
  );
  // The pipeline degrades a failed semantic leg to lexical-only; a measurement
  // must fail instead of reporting a lexical-only run as fused.
  if (semantic.status === 'failed') throw semantic.error;
  return candidates.map((c) => ({
    path: c.path,
    score: c.score,
    found_in: [
      ...(c.semantic ? ['semantic' as const] : []),
      ...(c.lexical ? ['lexical' as const] : []),
      ...(c.expansion ? ['expansion' as const] : []),
    ],
  }));
}

export async function rankQuery(args: {
  pipeline: PipelineId;
  shape: RunShape;
  /** The strings of one call — `semantic` takes exactly one. */
  queries: string[];
  /** Every query string embedded once by the caller, so all pipelines rank the same vectors. */
  vectors: ReadonlyMap<string, number[]>;
  /** The vault's own corpus, loaded in-process (design D15). */
  corpus: ICorpusReader;
  /** The lexical reader `fused` and `lexical` search. */
  context?: LexicalContext;
  similarity: SimilarityDefaults;
}): Promise<RankedPath[]> {
  if (args.pipeline === 'semantic') {
    const [query, ...rest] = args.queries;
    const vector = query === undefined ? undefined : args.vectors.get(query);
    if (rest.length > 0 || vector === undefined) {
      throw new Error('semantic pipeline ranks one embedded query string');
    }
    if (args.shape.run !== 'positional') {
      throw new Error('semantic pipeline runs positional only');
    }
    return rankSemantic(vector, args.corpus);
  }
  if (!args.context) {
    throw new Error(`${args.pipeline} pipeline requires a LexicalContext`);
  }
  return rankRetrieval({
    semantic: args.pipeline === 'fused',
    queries: args.queries,
    vectors: args.vectors,
    corpus: args.corpus,
    context: args.context,
    similarity: args.similarity,
    shape: args.shape,
  });
}
