import fs from 'node:fs/promises';
import path from 'node:path';

import { EmbeddingService } from './embedding-service.js';
import { findBlockNeighbors, findDuplicates, findNeighbors } from './search-engine.js';
import {
  createSmartConnectionsCorpusIndex,
  type SmartConnectionsCorpusIndex,
} from '../../lib/obsidian/smart-connections-corpus-index.js';
import { FsVaultReader, type VaultReader } from '../../lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../lib/obsidian/wikilink-graph.js';
import { buildSemanticTools, type SemanticToolDeps } from './tools/index.js';
import type { EmbeddingProvider, PathExistsCheck, SearchEngine } from './types.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import { createListMatchingPaths, type ListMatchingPaths } from '../../lib/obsidian/query/index.js';

export interface SemanticModuleConfig {
  vaultPath: string;
  smartEnvPath: string;
  modelKey: string;
  modelId: string;
}

export interface SemanticModuleDeps {
  corpusFactory?: (smartEnvPath: string, modelKey: string) => Promise<SmartConnectionsCorpusIndex>;
  embeddingServiceFactory?: (modelId: string) => EmbeddingProvider;
  searchEngine?: SearchEngine;
  pathExists?: PathExistsCheck;
  readNoteContent?: (vaultRelativePath: string) => Promise<string>;
  graph?: WikilinkGraphIndex;
  vaultReaderFactory?: (opts: { vaultRoot: string }) => VaultReader;
  listMatchingPaths?: ListMatchingPaths;
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

function createDefaultReadNoteContent(
  vaultPath: string,
): (vaultRelativePath: string) => Promise<string> {
  return (vaultRelativePath) => fs.readFile(path.join(vaultPath, vaultRelativePath), 'utf8');
}

export interface SemanticModule {
  tools: ToolRegistration[];
  warmup: () => Promise<void>;
}

export async function createSemanticModule(
  config: SemanticModuleConfig,
  deps: SemanticModuleDeps = {},
): Promise<SemanticModule> {
  const corpusFactory =
    deps.corpusFactory ??
    ((smartEnvPath, modelKey) => createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey }));
  const embeddingServiceFactory =
    deps.embeddingServiceFactory ??
    ((modelId: string) => new EmbeddingService({ modelKey: modelId }));
  const searchEngine = deps.searchEngine ?? { findNeighbors, findBlockNeighbors, findDuplicates };

  const corpus = await corpusFactory(config.smartEnvPath, config.modelKey);
  const initial = await corpus.snapshot();
  if (initial.sources.size === 0) {
    throw new Error('Loaded Smart Connections corpus is empty');
  }

  const embeddingService = embeddingServiceFactory(config.modelId);
  const pathExists = deps.pathExists ?? createDefaultPathExists(config.vaultPath);
  const readNoteContent = deps.readNoteContent ?? createDefaultReadNoteContent(config.vaultPath);

  let graph = deps.graph;
  let listMatchingPaths = deps.listMatchingPaths;

  if (!graph || !listMatchingPaths) {
    const readerFactory =
      deps.vaultReaderFactory ?? ((opts) => new FsVaultReader({ vaultRoot: opts.vaultRoot }));
    const reader = readerFactory({ vaultRoot: config.vaultPath });
    if (!graph) graph = new WikilinkGraphIndex({ reader });
    if (!listMatchingPaths) listMatchingPaths = createListMatchingPaths({ reader, graph });
  }

  const semanticDeps: SemanticToolDeps = {
    corpus,
    embeddingProvider: embeddingService,
    searchEngine,
    modelKey: config.modelKey,
    pathExists,
    readNoteContent,
    graph,
    listMatchingPaths,
  };

  return {
    tools: buildSemanticTools(semanticDeps),
    warmup: async () => {
      await embeddingService.initialize();
    },
  };
}
