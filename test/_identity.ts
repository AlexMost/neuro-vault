import { corpusIdentityOf, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import type { EmbeddingIdentity } from '../src/lib/obsidian/corpus/types.js';
import type { SimilarityDefaults } from '../src/modules/semantic/model-profiles.js';

/** Vector width every corpus test writes and reads. */
export const TEST_DIMS = 384;

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

/** Today's bge-scale defaults, for fixtures that do not care about the scale. */
export const TEST_SIMILARITY: SimilarityDefaults = {
  quick: 0.5,
  deep: 0.35,
  fallback: 0.3,
  expansionFloor: 0.35,
  similarNotes: 0.5,
  duplicates: 0.9,
};
