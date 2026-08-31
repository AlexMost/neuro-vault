import type { SearchEffort } from './types.js';

/**
 * The single source of the quick/deep retrieval profile. Everything that
 * states one of these numbers — retrieval-policy defaults, the pipeline's
 * pool caps, the search_notes description prose, the eval config — reads
 * this file; a retune here is the whole retune.
 */
export interface EffortProfile {
  /** Semantic-leg seed pool (retrieval-policy `limit`). */
  semanticPool: number;
  /** Default query↔note similarity floor for the semantic leg. */
  semanticThreshold: number;
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
    semanticThreshold: 0.5,
    lexicalNoteCap: 5,
    expansion: false,
    expansionLimit: 0,
    mergedCap: 5,
  },
  deep: {
    semanticPool: 8,
    semanticThreshold: 0.35,
    lexicalNoteCap: 10,
    expansion: true,
    expansionLimit: 3,
    mergedCap: 12,
  },
};

/** Per-note lexical evidence cap — effort-independent. */
export const LEXICAL_PER_NOTE_CAP = 3;

/** One-shot retry floor when a DEFAULT threshold finds nothing (never for an explicit threshold). */
export const FALLBACK_THRESHOLD = 0.3;

/** Default seed↔note floor for the expansion leg — a different scale than semanticThreshold. */
export const DEFAULT_EXPANSION_FLOOR = 0.35;
