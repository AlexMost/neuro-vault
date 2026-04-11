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

export interface SearchResult {
  path: string;
  similarity: number;
  blocks: SmartBlock[];
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

export interface SearchEngine {
  findNeighbors(args: {
    queryVector: number[];
    sources: Iterable<SmartSource>;
    threshold: number;
    limit?: number;
    excludePath?: string;
  }): SearchResult[];
  findDuplicates(args: { sources: Iterable<SmartSource>; threshold: number }): DuplicatePair[];
}

export interface SearchNotesInput {
  query: string;
  limit?: number;
  threshold?: number;
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
}

export type ToolHandlerErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'DEPENDENCY_ERROR';

export interface ToolHandlers {
  searchNotes(input: SearchNotesInput): Promise<SearchResult[]>;
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SearchResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
  getStats(): Promise<ToolStats>;
}
