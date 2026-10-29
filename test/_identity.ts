import { corpusIdentityOf, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import type { EmbeddingIdentity } from '../src/lib/obsidian/corpus/types.js';
import type { SimilarityDefaults } from '../src/lib/model-profiles.js';

/** Vector width every corpus test writes and reads. */
export const TEST_DIMS = 384;

/** An arbitrary producer for corpus tests — deliberately not a registry profile. */
export const TEST_EMBEDDING_IDENTITY: EmbeddingIdentity = {
  provider: 'test',
  model_key: 'bge-micro-v2',
  model_id: 'TaylorAI/bge-micro-v2',
  revision: 'test-revision',
  dtype: 'q8',
  dims: TEST_DIMS,
  pooling: 'mean',
  max_tokens: 512,
};

export const TEST_IDENTITY: CorpusIdentity = corpusIdentityOf(TEST_EMBEDDING_IDENTITY);

/**
 * Fixed defaults for fixtures that do not care about the scale — the retired
 * bge-micro-v2 values, which the fixtures' similarities were written against.
 * It carries a fallback, and its block floor equals its `deep`, so fixtures
 * written before either became independent keep their meaning.
 */
export const TEST_SIMILARITY: Required<SimilarityDefaults> = {
  quick: 0.5,
  deep: 0.35,
  fallback: 0.3,
  blockFloor: 0.35,
  expansionFloor: 0.35,
  similarNotes: 0.5,
  duplicates: 0.9,
};
