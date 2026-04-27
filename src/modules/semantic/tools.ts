import { registerTool } from '../../lib/tool-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import { buildFindDuplicatesTool } from './tools/find-duplicates.js';
import { buildGetSimilarNotesTool } from './tools/get-similar-notes.js';
import { buildGetStatsTool } from './tools/get-stats.js';
import { buildSearchNotesTool, type SearchNotesDeps } from './tools/search-notes.js';
import type { ToolHandlers } from './types.js';

export function buildSemanticTools(
  handlers: ToolHandlers,
  deps: SearchNotesDeps,
): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    registerTool(buildFindDuplicatesTool(deps)),
    registerTool(buildGetStatsTool(deps)),
  ];
}
