export interface SmartBlock {
  text: string;
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
  noteA: string;
  noteB: string;
  similarity: number;
}

export interface ServerConfig {
  vaultPath: string;
  smartEnvPath: string;
  modelKey: string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}
