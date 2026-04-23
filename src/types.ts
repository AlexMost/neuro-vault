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

export interface SearchResultBlock {
  heading: string;
  lines: [number, number];
}

export interface BlockSearchResult {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
}

export interface TextSearchResult {
  path: string;
  matchLine: string;
  lineNumber: number;
}

export interface SearchResult {
  path: string;
  similarity: number;
  blocks: SearchResultBlock[];
}

export interface DuplicatePair {
  note_a: string;
  note_b: string;
  similarity: number;
}

export interface ServerConfig {
  vaultPath: string;
  smartEnvPath: string;
  modelKey: string;
  modelId: string;
}

export interface EmbeddingProvider {
  initialize(): Promise<void>;
  embed(text: string): Promise<number[]>;
}

export interface TextSearchProvider {
  isAvailable(): Promise<boolean>;
  search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]>;
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
  expansion?: boolean;
  expansion_limit?: number;
}

export interface GetSimilarNotesInput {
  note_path: string;
  limit?: number;
  threshold?: number;
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

export interface ToolHandlerDependencies {
  loader: {
    sources: Map<string, SmartSource>;
  };
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  vaultPath: string;
  obsidianSearch?: TextSearchProvider;
}

export type ToolHandlerErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'DEPENDENCY_ERROR';

export interface ToolHandlers {
  searchNotes(input: SearchNotesInput): Promise<import('./retrieval-policy.js').RetrievalOutput>;
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SearchResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
  getStats(): Promise<ToolStats>;
}
