import fs from 'node:fs/promises';
import path from 'node:path';

import { EmbeddingService } from './embedding-service.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import {
  loadSmartConnectionsCorpus,
  type SmartConnectionsCorpus,
} from './smart-connections-loader.js';
import { createToolHandlers } from './tool-handlers.js';
import { buildSemanticTools } from './tools.js';
import type { SearchNotesDeps } from './tools/search-notes.js';
import type {
  EmbeddingProvider,
  PathExistsCheck,
  SearchEngine,
  ToolHandlerDependencies,
  ToolHandlers,
} from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';

export interface SemanticModuleConfig {
  vaultPath: string;
  smartEnvPath: string;
  modelKey: string;
  modelId: string;
}

export interface SemanticModuleDeps {
  loadCorpus?: (smartEnvPath: string, modelKey: string) => Promise<SmartConnectionsCorpus>;
  embeddingServiceFactory?: (modelId: string) => EmbeddingProvider;
  searchEngine?: SearchEngine;
  toolHandlersFactory?: (deps: ToolHandlerDependencies) => ToolHandlers;
  pathExists?: PathExistsCheck;
}

function createDefaultPathExists(vaultPath: string): PathExistsCheck {
  return async (vaultRelativePath) => {
    try {
      await fs.access(path.join(vaultPath, vaultRelativePath));
      return true;
    } catch {
      return false;
    }
  };
}

export interface SemanticModule {
  tools: ToolRegistration[];
  warmup: () => Promise<void>;
}

export async function createSemanticModule(
  config: SemanticModuleConfig,
  deps: SemanticModuleDeps = {},
): Promise<SemanticModule> {
  const loadCorpus = deps.loadCorpus ?? loadSmartConnectionsCorpus;
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ??
    ((modelId: string) => new EmbeddingService({ modelKey: modelId }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };
  const toolHandlersFactory = deps.toolHandlersFactory ?? createToolHandlers;

  const corpus = await loadCorpus(config.smartEnvPath, config.modelKey);
  if (corpus.sources.size === 0) {
    throw new Error('Loaded Smart Connections corpus is empty');
  }

  const embeddingService = embeddingServiceFactory(config.modelId);
  const pathExists = deps.pathExists ?? createDefaultPathExists(config.vaultPath);
  const handlers = toolHandlersFactory({
    loader: corpus,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
    pathExists,
  });

  const searchDeps: SearchNotesDeps = {
    sources: corpus.sources,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
    pathExists,
  };

  return {
    tools: buildSemanticTools(handlers, searchDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}
