/** A block as the chunker produces it: identity + span + its own text. */
export interface ChunkedBlock {
  /** Heading path within the note, e.g. "#Top#Inner". Never includes the note path. */
  key: string;
  /** The last heading segment of `key` ("Inner"), or "" for the root/frontmatter blocks. */
  heading: string;
  /** 1-based inclusive line span within the note. */
  lines: [number, number];
  /** The block's own text, exactly as it appears in the note. */
  text: string;
}

export interface NoteEmbedInputs {
  path: string;
  /** null when the note is below MIN_CHARS. */
  note: string | null;
  blocks: Array<ChunkedBlock & { embedText: string }>;
}

export interface CorpusBlock {
  key: string;
  heading: string;
  lines: [number, number];
  /** base64 of a little-endian Float32Array. */
  embedding: string;
}

export interface CorpusShard {
  path: string;
  content_hash: string;
  mtime: number;
  size: number;
  /** base64 vector, or null for a note below MIN_CHARS. */
  embedding: string | null;
  blocks: CorpusBlock[];
}

export interface CorpusManifest {
  embed_version: number;
  model_key: string;
  dims: number;
  strategy: string;
  created: string;
}

/** The indexer's only view of the embedding model (design D1). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Notes and blocks shorter than this are not embedded. */
export const MIN_CHARS = 200;
export const MAX_TOKENS = 512;
/** Note embed text is cut here — max_tokens x 3.7, the parity formula. */
export const EMBED_CHAR_BUDGET = Math.floor(MAX_TOKENS * 3.7);
export const MODEL_DIMS = 384;
export const SC_PARITY_STRATEGY = 'sc-parity-v1';
export const EMBED_VERSION = 1;
