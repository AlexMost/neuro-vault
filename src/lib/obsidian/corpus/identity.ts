import {
  EMBED_VERSION,
  SC_PARITY_STRATEGY,
  type CorpusManifest,
  type EmbeddingIdentity,
} from './types.js';

/** What a manifest records and a stored corpus is checked against. */
export type CorpusIdentity = Omit<CorpusManifest, 'created'>;

/**
 * The corpus identity of vectors produced by `embedding` under this build's
 * text extraction. Until the manifest records the full producer (design D8),
 * it keeps exactly the five fields existing manifests carry, so no corpus is
 * invalidated by this refactor.
 */
export function corpusIdentityOf(embedding: EmbeddingIdentity): CorpusIdentity {
  return {
    embed_version: EMBED_VERSION,
    model_key: embedding.model_key,
    model_id: embedding.model_id,
    dims: embedding.dims,
    strategy: SC_PARITY_STRATEGY,
  };
}
