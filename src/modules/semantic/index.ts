import { EmbeddingService } from './embedding-service.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import { buildSemanticTools, type SemanticToolDeps } from './tools/index.js';
import type { EmbeddingProvider, SearchEngine } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { VaultRegistry } from '../../lib/vault-registry.js';

export interface SemanticModuleConfig {
  modelKey: string;
  modelId: string;
}

export interface SemanticModuleDeps {
  embeddingServiceFactory?: (modelId: string) => EmbeddingProvider;
  searchEngine?: SearchEngine;
}

export interface SemanticModule {
  tools: ToolRegistration[];
  warmup: () => Promise<void>;
}

export function createSemanticModule(
  registry: VaultRegistry,
  config: SemanticModuleConfig,
  deps: SemanticModuleDeps = {},
): SemanticModule {
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ??
    ((modelId: string) => new EmbeddingService({ modelKey: modelId }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };
  const embeddingService = embeddingServiceFactory(config.modelId);

  const semanticDeps: SemanticToolDeps = {
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
