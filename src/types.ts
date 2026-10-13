import type { ModelProfile } from './modules/semantic/model-profiles.js';

export type {
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchNotesInput,
  GetSimilarNotesInput,
  FindDuplicatesInput,
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
}

export interface ServerConfig {
  vaults: IVaultConfig[]; // length >= 1, names unique
  semantic: {
    enabled: boolean;
    /** The one embedding profile this process serves (design D3). */
    model: ModelProfile;
  };
}
