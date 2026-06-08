import type { MultiRetrievalOutput, RetrievalOutput } from './retrieval-policy.js';
import type { SmartSource } from '../../lib/obsidian/smart-connections-types.js';
import type {
  ListMatchingPaths,
  NoteFilter,
} from '../../lib/obsidian/query/list-matching-paths.js';

export type { SmartBlock, SmartSource } from '../../lib/obsidian/smart-connections-types.js';
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
  blocks: BlockMatch[];
  related: RelatedNote[];
}

export interface MultiNoteResultNode extends NoteResultNode {
  matched_queries: string[];
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

export interface EmbeddingProvider {
  initialize(): Promise<void>;
  embed(text: string): Promise<number[]>;
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
  embeddingProvider: EmbeddingProvider;
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
  | 'SEMANTIC_INDEX_NOT_FOUND';

export interface ToolHandlers {
  searchNotes(input: SearchNotesInput): Promise<RetrievalOutput | MultiRetrievalOutput>;
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SimilarNoteResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
}
