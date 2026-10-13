import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

/** How a model's token states become one vector. */
export type Pooling = 'mean' | 'cls' | 'last_token';

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
}

/** The provider name every identity of this package's local provider carries. */
export const LOCAL_PROVIDER = 'transformers.js';

const BGE_MICRO_V2: ModelProfile = {
  key: 'bge-micro-v2',
  repo: 'TaylorAI/bge-micro-v2',
  revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
  dtype: 'q8',
  dims: 384,
  pooling: 'mean',
  queryPrefix: '',
  documentPrefix: '',
  maxTokens: 512,
};

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
};

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze({
  [BGE_MICRO_V2.key]: BGE_MICRO_V2,
  [GRANITE_97M.key]: GRANITE_97M,
  [HARRIER_270M.key]: HARRIER_270M,
  [HARRIER_0_6B.key]: HARRIER_0_6B,
});

export const DEFAULT_MODEL_KEY = BGE_MICRO_V2.key;

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
