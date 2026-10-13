import {
  EMBED_STRATEGY,
  EMBED_VERSION,
  type CorpusManifest,
  type EmbeddingIdentity,
  type StoredManifest,
} from './types.js';

/** What a manifest records and a stored corpus is checked against. */
export type CorpusIdentity = Omit<CorpusManifest, 'created'>;

/** Every field a stored corpus must match to be reused (design D8); `created` is not one. */
export const IDENTITY_FIELDS = [
  'embed_version',
  'provider',
  'model_key',
  'model_id',
  'revision',
  'dtype',
  'dims',
  'pooling',
  'max_tokens',
  'strategy',
] as const satisfies ReadonlyArray<keyof CorpusIdentity>;

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

/**
 * Both sides of a rebuild, named. When the model key and version agree, the
 * mismatch is in a field {@link formatIdentity} does not show (a revision,
 * a dtype, …), so each side also names the fields that differ — otherwise the
 * log would read "indexed with X; active model is X".
 */
export function formatRebuild(
  stored: StoredManifest | null,
  active: CorpusIdentity,
): { stored: string; active: string } {
  const pair = { stored: formatIdentity(stored), active: formatIdentity(active) };
  if (stored === null || pair.stored !== pair.active) return pair;
  const differing = IDENTITY_FIELDS.filter((field) => stored[field] !== active[field]);
  if (differing.length === 0) return pair;
  const name = (identity: Partial<CorpusIdentity>): string =>
    `${active.model_key} (embed_version ${active.embed_version}, ${differing
      .map((field) => `${field} ${identity[field] ?? 'unset'}`)
      .join(', ')})`;
  return { stored: name(stored), active: name(active) };
}
