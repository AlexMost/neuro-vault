import type { EmbeddingIdentity, SmartSource } from '../../lib/obsidian/corpus/types.js';
import type {
  ListMatchingPaths,
  NoteFilter,
} from '../../lib/obsidian/query/list-matching-paths.js';

export type { SmartBlock, SmartSource } from '../../lib/obsidian/corpus/types.js';
export type { ListMatchingPaths, NoteFilter };

// Engine-level result types — what SearchEngine.findNeighbors and friends return.
// These describe a single hit; they have no notion of "which query" or "expansion".
export interface BlockSearchResult {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
}

export interface SearchResult {
  path: string;
  similarity: number;
}

// Tree node types — what tools emit. Direct-result-per-note, with leaves for
// blocks belonging to that note and expansion neighbours of that note.
export interface BlockMatch {
  heading: string;
  lines: [number, number];
  similarity: number;
}

export interface RelatedNote {
  path: string;
  expansion_similarity: number;
}

export interface NoteResultNode {
  path: string;
  similarity: number;
  // Always populated. For a single-query call this is `[query]` — arity is a
  // surfacing concern in the tool layer, not a retrieval one. Whether it
  // reaches the MCP response is decided by `isMulti` in
  // `runSearchForEntry`'s shaping pass (search-notes.ts).
  matched_queries: string[];
  blocks: BlockMatch[];
  related: RelatedNote[];
}

export interface SimilarNoteResult {
  path: string;
  similarity?: number;
  signals: {
    semantic?: number;
    forward_link?: true;
  };
}

export interface DuplicatePair {
  note_a: string;
  note_b: string;
  similarity: number;
}

/** What the retrieval path needs from an embedder: queries only. */
export interface QueryEmbedder {
  initialize(): Promise<void>;
  /** Embeds a search query; the provider applies its profile's query prefix. */
  embedQuery(text: string): Promise<number[]>;
}

/**
 * A full embedding provider (design D4): the local transformers.js one today,
 * possibly a remote API later. Queries and documents are separate calls so the
 * query prefix stays a provider concern no caller can forget.
 */
export interface EmbeddingProvider extends QueryEmbedder {
  /** What produces this provider's vectors; the corpus manifest records it. */
  readonly identity: EmbeddingIdentity;
  /** The most texts one `embedDocuments` call accepts. */
  readonly maxBatchSize: number;
  /** Embeds document texts (no query prefix), vectors in input order. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /**
   * Releases a connection the provider holds, rejecting what is pending on
   * it. Optional: the in-process provider holds none.
   */
  close?(): void;
}

export interface SearchEngine {
  findNeighbors(args: {
    queryVector: number[];
    sources: Iterable<SmartSource>;
    threshold: number;
    limit?: number;
    excludePath?: string;
  }): SearchResult[];
  findBlockNeighbors(args: {
    queryVector: number[];
    sources: Iterable<SmartSource>;
    threshold: number;
    limit?: number;
  }): BlockSearchResult[];
  findDuplicates(args: { sources: Iterable<SmartSource>; threshold: number }): DuplicatePair[];
}

export type SearchMode = 'quick' | 'deep';

// Public-facing input axes for search_notes. `SearchChannelMode` picks which
// retrieval leg(s) run; `SearchEffort` maps onto the internal `SearchMode`
// (quick|deep) retrieval-policy vocabulary above — kept separate so the
// public contract can evolve independently of retrieval-policy internals.
export type SearchChannelMode = 'hybrid' | 'lexical';
export type SearchEffort = 'quick' | 'deep';

export interface SearchNotesInput {
  query: string | string[];
  mode?: SearchMode;
  limit?: number;
  threshold?: number;
  filter?: NoteFilter;
}

export interface GetSimilarNotesInput {
  path: string;
  limit?: number;
  threshold?: number;
  exclude_folders?: string[];
}

export interface FindDuplicatesInput {
  threshold?: number;
}

export type PathExistsCheck = (vaultRelativePath: string) => Promise<boolean>;

export interface ToolHandlerDependencies {
  loader: {
    sources: Map<string, SmartSource>;
  };
  embeddingProvider: QueryEmbedder;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists?: PathExistsCheck;
  listMatchingPaths: ListMatchingPaths;
}

export type ToolHandlerErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'DEPENDENCY_ERROR'
  | 'VAULT_REQUIRED'
  | 'VAULT_NOT_FOUND'
  | 'SEMANTIC_INDEX_NOT_FOUND'
  | 'SEMANTIC_INDEX_BUILDING'
  | 'SEMANTIC_DISABLED';

export interface ToolHandlers {
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SimilarNoteResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
}
