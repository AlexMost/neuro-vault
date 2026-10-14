import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

/** How a model's token states become one vector. */
export type Pooling = 'mean' | 'cls' | 'last_token';

/**
 * Default similarity thresholds, on this profile's own similarity scale
 * (design D10). Each profile carries values calibrated on its own corpus
 * (design D11; numbers in openspec/changes/archive/2026-10-13-embedding-model-profiles/calibration.md).
 */
export interface SimilarityDefaults {
  /** `search_notes` semantic floor at effort "quick". */
  readonly quick: number;
  /** `search_notes` semantic floor at effort "deep"; also the deep block-evidence floor. */
  readonly deep: number;
  /** One-shot retry floor when a default threshold finds nothing. */
  readonly fallback: number;
  /** Default seed↔note floor for the expansion leg. */
  readonly expansionFloor: number;
  /** `get_similar_notes` default threshold. */
  readonly similarNotes: number;
  /** `find_duplicates` default threshold. */
  readonly duplicates: number;
}

/**
 * Everything model-specific, in one record (design D2). A profile joins the
 * registry only after it has been measured on the retrieval eval and verified
 * against the pinned transformers.js version, so the registry is closed on
 * purpose: no input ever names a repository directly.
 */
export interface ModelProfile {
  /** Registry key — what `--model` takes and the manifest records as `model_key`. */
  readonly key: string;
  /** Hugging Face repository the tokenizer and weights load from. */
  readonly repo: string;
  /** The exact repository commit the profile was verified against; never a branch. */
  readonly revision: string;
  readonly dtype: 'q8';
  readonly dims: number;
  readonly pooling: Pooling;
  /** Prepended to every query by the provider; callers never add it. */
  readonly queryPrefix: string;
  /** Prepended to every document by the provider. */
  readonly documentPrefix: string;
  /** Input window in tokens of this profile's tokenizer, special tokens included. */
  readonly maxTokens: number;
  /** Default similarity thresholds on this profile's own scale (design D10). */
  readonly similarity: SimilarityDefaults;
}

/** The provider name every identity of this package's local provider carries. */
export const LOCAL_PROVIDER = 'transformers.js';

const GRANITE_97M: ModelProfile = {
  key: 'granite-97m',
  repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
  revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
  dtype: 'q8',
  dims: 384,
  pooling: 'cls',
  queryPrefix: '',
  documentPrefix: '',
  maxTokens: 512,
  similarity: Object.freeze({
    quick: 0.71,
    deep: 0.66,
    fallback: 0.65,
    expansionFloor: 0.65,
    similarNotes: 0.67,
    duplicates: 0.9,
  }),
};

/** harrier's retrieval instruction (model card); documents take no prompt. */
const HARRIER_QUERY_PREFIX =
  'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

const HARRIER_270M: ModelProfile = {
  key: 'harrier-270m',
  repo: 'onnx-community/harrier-oss-v1-270m-ONNX',
  revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
  dtype: 'q8',
  dims: 640,
  pooling: 'last_token',
  queryPrefix: HARRIER_QUERY_PREFIX,
  documentPrefix: '',
  maxTokens: 512,
  similarity: Object.freeze({
    quick: 0.2,
    deep: 0.13,
    fallback: 0.05,
    expansionFloor: 0.2,
    similarNotes: 0.22,
    duplicates: 0.77,
  }),
};

const HARRIER_0_6B: ModelProfile = {
  key: 'harrier-0.6b',
  repo: 'onnx-community/harrier-oss-v1-0.6b-ONNX',
  revision: 'e4daffa011e666dcd2ff2a3c6c05084090ac314d',
  dtype: 'q8',
  dims: 1024,
  pooling: 'last_token',
  queryPrefix: HARRIER_QUERY_PREFIX,
  documentPrefix: '',
  maxTokens: 512,
  similarity: Object.freeze({
    quick: 0.25,
    deep: 0.19,
    fallback: 0.15,
    expansionFloor: 0.25,
    similarNotes: 0.29,
    duplicates: 0.76,
  }),
};

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  [HARRIER_270M.key]: HARRIER_270M,
  [GRANITE_97M.key]: GRANITE_97M,
  [HARRIER_0_6B.key]: HARRIER_0_6B,
});

export const DEFAULT_MODEL_KEY = HARRIER_270M.key;

export const MODEL_KEYS: readonly string[] = Object.freeze(Object.keys(MODEL_PROFILES));

export function resolveModelProfile(key: string): ModelProfile {
  if (!Object.hasOwn(MODEL_PROFILES, key)) {
    throw new Error(`unknown model "${key}" — choose one of: ${MODEL_KEYS.join(', ')}`);
  }
  return MODEL_PROFILES[key];
}

/** The identity the local provider reports for vectors produced under `profile`. */
export function identityOf(profile: ModelProfile): EmbeddingIdentity {
  return {
    provider: LOCAL_PROVIDER,
    model_key: profile.key,
    model_id: profile.repo,
    revision: profile.revision,
    dtype: profile.dtype,
    dims: profile.dims,
    pooling: profile.pooling,
    max_tokens: profile.maxTokens,
  };
}
