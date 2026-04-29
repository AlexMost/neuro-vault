import type { MultiRetrievalOutput, RetrievalOutput } from './retrieval-policy.js';
import type { SmartSource } from '../../lib/obsidian/smart-connections-types.js';

export type { SmartBlock, SmartSource } from '../../lib/obsidian/smart-connections-types.js';

export interface BlockSearchResult {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
}

export interface SearchResult {
  path: string;
  similarity: number;
  via_expansion?: true;
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

export interface ToolStats {
  totalNotes: number;
  totalBlocks: number;
  embeddingDimension: number;
  modelKey: string;
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
}

export type ToolHandlerErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'DEPENDENCY_ERROR';

export interface ToolHandlers {
  searchNotes(input: SearchNotesInput): Promise<RetrievalOutput | MultiRetrievalOutput>;
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SimilarNoteResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
  getStats(): Promise<ToolStats>;
}

export interface MultiSearchResult extends SearchResult {
  matched_queries?: string[];
  via_expansion?: true;
}

export interface MultiBlockSearchResult extends BlockSearchResult {
  matched_queries: string[];
}
