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
  note_a: string;
  note_b: string;
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
