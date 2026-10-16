import type { ModelProfile } from './lib/model-profiles.js';

export type {
  EmbeddingProvider,
  QueryEmbedder,
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
    /** Embed through the shared per-machine daemon (default) or load the model in-process. */
    shared: boolean;
  };
}

export interface DaemonCliOptions {
  /** Absent: run the daemon. */
  action?: 'status' | 'stop';
  /** 0 = never exit on idle. */
  idleTimeoutMinutes: number;
}
