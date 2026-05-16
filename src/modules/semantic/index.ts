import { EmbeddingService } from './embedding-service.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import { buildSemanticTools, type ISemanticToolDeps } from './tools/index.js';
import type { EmbeddingProvider, SearchEngine } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { IVaultRegistry } from '../../lib/vault-registry.js';

export interface ISemanticModuleConfig {
  modelKey: string;
  modelId: string;
}

export interface ISemanticModuleDeps {
  embeddingServiceFactory?: (modelId: string) => EmbeddingProvider;
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
    deps.embeddingServiceFactory ??
    ((modelId: string) => new EmbeddingService({ modelKey: modelId }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };
  const embeddingService = embeddingServiceFactory(config.modelId);

  const semanticDeps: ISemanticToolDeps = {
    registry,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
  };
  return {
    tools: buildSemanticTools(semanticDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}
