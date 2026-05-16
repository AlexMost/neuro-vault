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

export interface IVaultConfig {
  name: string;
  path: string; // absolute, normalized
  smartEnvPath: string; // <path>/.smart-env/multi
}

export interface ServerConfig {
  vaults: IVaultConfig[]; // length >= 1, names unique
  semantic: {
    enabled: boolean;
    modelKey: string;
    modelId: string;
  };
  obsidianCli?: string;
}
