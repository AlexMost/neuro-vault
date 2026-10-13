import { EmbeddingService } from './embedding-service.js';
import type { ModelProfile } from './model-profiles.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import { buildSemanticTools, type ISemanticToolDeps } from './tools/index.js';
import type { QueryEmbedder, SearchEngine } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { IVaultRegistry } from '../../lib/vault-registry.js';

export interface ISemanticModuleConfig {
  profile: ModelProfile;
}

export interface ISemanticModuleDeps {
  embeddingServiceFactory?: (profile: ModelProfile) => QueryEmbedder;
  searchEngine?: SearchEngine;
}

export interface ISemanticModule {
  tools: ToolRegistration[];
  warmup: () => Promise<void>;
}

export function createSemanticModule(
  registry: IVaultRegistry,
  config: ISemanticModuleConfig,
  deps: ISemanticModuleDeps = {},
): ISemanticModule {
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ?? ((profile: ModelProfile) => new EmbeddingService({ profile }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };
  const embeddingService = embeddingServiceFactory(config.profile);

  const semanticDeps: ISemanticToolDeps = {
    registry,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.profile.key,
    similarity: config.profile.similarity,
  };
  return {
    tools: buildSemanticTools(semanticDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}
