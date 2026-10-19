import type { SearchEffort } from './types.js';

/**
 * The single source of the quick/deep retrieval profile's model-independent
 * knobs. Retrieval-policy defaults, the pipeline's pool caps, the
 * search_notes description prose and the eval report's `config` all read this
 * file, so a retune here reaches every one of them. The similarity thresholds
 * are not here: they depend on the embedding model's score scale, so they live
 * on `ModelProfile.similarity`.
 */
export interface EffortProfile {
  /** Semantic-leg seed pool (retrieval-policy `limit`). */
  semanticPool: number;
  /** Lexical-leg note pool (`noteCap`). */
  lexicalNoteCap: number;
  /** Whether the expansion leg runs at this effort. */
  expansion: boolean;
  /** Per-seed expansion neighbour cap. */
  expansionLimit: number;
  /** Default cap on the final fused `matches[]` list. */
  mergedCap: number;
}

export const EFFORT_PROFILES: Record<SearchEffort, EffortProfile> = {
  quick: {
    semanticPool: 3,
    lexicalNoteCap: 5,
    expansion: false,
    expansionLimit: 0,
    mergedCap: 5,
  },
  deep: {
    semanticPool: 8,
    lexicalNoteCap: 10,
    expansion: true,
    expansionLimit: 3,
    mergedCap: 12,
  },
};

/** Per-note lexical evidence cap — effort-independent. */
export const LEXICAL_PER_NOTE_CAP = 3;
