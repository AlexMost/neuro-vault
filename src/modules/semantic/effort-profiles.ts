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
  /** Lexical-leg note pool (`noteCap`) when the semantic leg runs too. */
  lexicalNoteCap: number;
  /**
   * Whether the expansion leg runs at this effort. Off in every profile since
   * #270: notes that only this leg surfaced were relevant 4 % and 1 % of the
   * time on two vaults, and switching it off raised precision with MRR held.
   * The step stays in `executeRetrieval` behind an explicit `expansion` input
   * that no caller sets.
   */
  expansion: boolean;
  /** Per-seed expansion neighbour cap; 0 in every profile (see `expansion`). */
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
    expansion: false,
    expansionLimit: 0,
    mergedCap: 12,
  },
};

/**
 * The lexical leg's note pool. When it is the only source (`mode: lexical`, or no semantic
 * leg to run), the pool is the call's merged cap — `limit` when the caller passed one,
 * else the effort's default — so a caller asking for more notes gets them (#264). Beside
 * the semantic leg it keeps its own cap: there the merged cap, not the leg pool, binds (#229).
 * That includes a call whose semantic leg was requested but then failed: the lexical leg
 * runs first, so its pool is already sized for a hybrid call.
 */
export function lexicalPool(effort: SearchEffort, lexicalOnly: boolean, cap?: number): number {
  const profile = EFFORT_PROFILES[effort];
  return lexicalOnly ? (cap ?? profile.mergedCap) : profile.lexicalNoteCap;
}

/** Per-note lexical evidence cap — effort-independent. */
export const LEXICAL_PER_NOTE_CAP = 3;
