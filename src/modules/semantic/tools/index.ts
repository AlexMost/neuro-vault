import { registerTool } from '../../../lib/tool-registry.js';
import type { ToolRegistration } from '../../../lib/tool-registration.js';
import type { EmbeddingProvider, SearchEngine } from '../types.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { buildFindDuplicatesTool } from './find-duplicates.js';
import { buildGetSimilarNotesTool } from './get-similar-notes.js';
import { buildGetStatsTool } from './get-stats.js';
import { buildSearchNotesTool } from './search-notes.js';

export interface SemanticToolDeps {
  registry: VaultRegistry;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
}

export function buildSemanticTools(deps: SemanticToolDeps): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
    registerTool(buildGetStatsTool(deps)),
  ];
}
