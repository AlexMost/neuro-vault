export interface SmartBlock {
  key: string;
  heading: string;
  lines: [number, number];
  embedding: number[];
}

export interface SmartSource {
  path: string;
  embedding: number[];
  blocks: SmartBlock[];
}

/** A block as the chunker produces it: identity + span + its own text. */
export interface ChunkedBlock {
  /** Heading path within the note, e.g. "#Top#Inner". Never includes the note path. */
  key: string;
  /**
   * The block's own heading text as written ("Inner"), carrying the same `[n]`
   * repeat suffix the key's last segment carries. Never re-derived from `key`,
   * which a heading containing "#" would corrupt. The frontmatter block carries
   * "---frontmatter---"; the preamble block and numbered content chunks carry "".
   */
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
  /** The repo id the vectors were produced from — changing it alone must rebuild. */
  model_id: string;
  dims: number;
  strategy: string;
  created: string;
}

/**
 * What produced a corpus's vectors, as the embedding provider reports it
 * (design D4). The corpus records this; it never derives it from constants
 * of its own, so a remote provider can describe itself the same way.
 */
export interface EmbeddingIdentity {
  provider: string;
  model_key: string;
  model_id: string;
  revision: string;
  dtype: string;
  dims: number;
  pooling: string;
  max_tokens: number;
}

/** The indexer's only view of the embedding model (design D1). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Notes and blocks shorter than this are not embedded. */
export const MIN_CHARS = 200;
/** Note embed text is cut here — the Smart Connections parity formula, 512 tokens × 3.7. */
export const EMBED_CHAR_BUDGET = 1894;
export const SC_PARITY_STRATEGY = 'sc-parity-v1';
export const EMBED_VERSION = 1;
