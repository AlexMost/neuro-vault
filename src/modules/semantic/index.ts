import fs from 'node:fs/promises';
import path from 'node:path';

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

  // Transitional shape: tool handlers in Task 8 will use registry directly.
  // Today they close over the first available entry's primitives.
  const entry = registry.list()[0];
  if (!entry.corpus) {
    // Semantic module enabled but the only vault has no .smart-env/. Tools
    // will receive a sentinel corpus; calls will fail with DEPENDENCY_ERROR
    // until Task 8 swaps in resolveVault with SEMANTIC_INDEX_NOT_FOUND.
    throw new Error(
      `Semantic module enabled but vault "${entry.name}" has no Smart Connections corpus`,
    );
  }

  const vaultPath = entry.path;
  const pathExists = async (vaultRelativePath: string) => {
    try {
      await fs.access(path.join(vaultPath, vaultRelativePath));
      return true;
    } catch {
      return false;
    }
  };
  const readNoteContent = (vaultRelativePath: string) =>
    fs.readFile(path.join(vaultPath, vaultRelativePath), 'utf8');

  const semanticDeps: SemanticToolDeps = {
    registry,
    corpus: entry.corpus,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
    pathExists,
    readNoteContent,
    graph: entry.graph,
    listMatchingPaths: entry.listMatchingPaths,
  };

  return {
    tools: buildSemanticTools(semanticDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}
