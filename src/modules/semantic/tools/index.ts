import { registerTool } from '../../../lib/tool-registry.js';
import type { ToolRegistration } from '../../../lib/tool-registration.js';
import type { EmbeddingProvider, PathExistsCheck, SearchEngine, SmartSource } from '../types.js';
import { buildFindDuplicatesTool } from './find-duplicates.js';
import { buildGetSimilarNotesTool } from './get-similar-notes.js';
import { buildGetStatsTool } from './get-stats.js';
import { buildSearchNotesTool } from './search-notes.js';

export interface SemanticToolDeps {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists: PathExistsCheck;
}

export function buildSemanticTools(deps: SemanticToolDeps): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
    registerTool(buildGetStatsTool(deps)),
  ];
}
