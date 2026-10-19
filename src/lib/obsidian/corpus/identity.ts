import {
  EMBED_STRATEGY,
  EMBED_VERSION,
  type CorpusManifest,
  type EmbeddingIdentity,
  type ProducerField,
  type StoredManifest,
} from './types.js';

/** What a manifest records and a stored corpus is checked against. */
export type CorpusIdentity = Omit<CorpusManifest, 'created'>;

/**
 * The identity a corpus has on record, wherever it keeps it. One recorded
 * before embed_version 2 lacks the producer fields — still readable, so a
 * rebuild can name what it replaces.
 */
export type RecordedIdentity = Omit<CorpusIdentity, ProducerField> &
  Partial<Pick<CorpusIdentity, ProducerField>>;

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

/**
 * Whether a corpus recorded under `recorded` can serve `expected`: every
 * identity field agrees. Nothing on record never matches — vectors of unknown
 * provenance are not reused.
 */
export function identityMatches(
  recorded: RecordedIdentity | null,
  expected: CorpusIdentity,
): boolean {
  return recorded !== null && IDENTITY_FIELDS.every((field) => recorded[field] === expected[field]);
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
  stored: RecordedIdentity | null,
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

/**
 * Whether `value` is a readable manifest: every v2 field, with the producer
 * fields a legacy (v1) manifest lacks allowed to be absent. Shared by the
 * store and the legacy migration, so both agree on what "parses" means.
 */
export function isStoredManifest(value: unknown): value is StoredManifest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const optional = (key: string, type: 'string' | 'number') =>
    v[key] === undefined || typeof v[key] === type;
  return (
    typeof v.embed_version === 'number' &&
    typeof v.model_key === 'string' &&
    typeof v.model_id === 'string' &&
    typeof v.dims === 'number' &&
    typeof v.strategy === 'string' &&
    typeof v.created === 'string' &&
    optional('provider', 'string') &&
    optional('revision', 'string') &&
    optional('dtype', 'string') &&
    optional('pooling', 'string') &&
    optional('max_tokens', 'number')
  );
}
