import { registerTool } from '../../../lib/tool-registry.js';
import type { ToolRegistration } from '../../../lib/tool-registration.js';
import type { SmartConnectionsCorpusIndex } from '../../../lib/obsidian/smart-connections-corpus-index.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';
import type {
  EmbeddingProvider,
  ListMatchingPaths,
  PathExistsCheck,
  SearchEngine,
} from '../types.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { buildFindDuplicatesTool } from './find-duplicates.js';
import { buildGetSimilarNotesTool } from './get-similar-notes.js';
import { buildGetStatsTool } from './get-stats.js';
import { buildSearchNotesTool } from './search-notes.js';

export interface SemanticToolDeps {
  registry: VaultRegistry; // ← new, used in Task 8
  corpus: SmartConnectionsCorpusIndex;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists: PathExistsCheck;
  readNoteContent: (vaultRelativePath: string) => Promise<string>;
  graph: WikilinkGraphIndex;
  listMatchingPaths: ListMatchingPaths;
}

export function buildSemanticTools(deps: SemanticToolDeps): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
    registerTool(buildGetStatsTool(deps)),
  ];
}
