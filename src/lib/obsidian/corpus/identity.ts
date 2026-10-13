import {
  EMBED_STRATEGY,
  EMBED_VERSION,
  type CorpusManifest,
  type EmbeddingIdentity,
} from './types.js';

/** What a manifest records and a stored corpus is checked against. */
export type CorpusIdentity = Omit<CorpusManifest, 'created'>;

/**
 * The corpus identity of vectors produced by `embedding` under this build's
 * text extraction: every field the embedding provider reports (design D8),
 * plus this build's extraction version and strategy.
 */
export function corpusIdentityOf(embedding: EmbeddingIdentity): CorpusIdentity {
  return {
    embed_version: EMBED_VERSION,
    provider: embedding.provider,
    model_key: embedding.model_key,
    model_id: embedding.model_id,
    revision: embedding.revision,
    dtype: embedding.dtype,
    dims: embedding.dims,
    pooling: embedding.pooling,
    max_tokens: embedding.max_tokens,
    strategy: EMBED_STRATEGY,
  };
}

/** `<model_key> (embed_version <n>)` — how a rebuild names a corpus identity. */
export function formatIdentity(
  identity: Pick<CorpusManifest, 'model_key' | 'embed_version'> | null,
): string {
  if (identity === null) return 'an unreadable or missing manifest';
  return `${identity.model_key} (embed_version ${identity.embed_version})`;
}
