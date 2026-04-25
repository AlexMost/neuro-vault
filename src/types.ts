export type {
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchNotesInput,
  GetSimilarNotesInput,
  FindDuplicatesInput,
  ToolStats,
  ToolHandlerDependencies,
  ToolHandlerErrorCode,
  ToolHandlers,
  SmartBlock,
  SmartSource,
  BlockSearchResult,
  SearchResult,
  DuplicatePair,
} from './modules/semantic/types.js';

export interface ServerConfig {
  vaultPath: string;
  semantic: {
    enabled: boolean;
    smartEnvPath: string;
    modelKey: string;
    modelId: string;
  };
  operations: {
    enabled: boolean;
    binaryPath?: string;
  };
}
