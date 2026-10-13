import { corpusIdentityOf, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import type { EmbeddingIdentity } from '../src/lib/obsidian/corpus/types.js';

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
