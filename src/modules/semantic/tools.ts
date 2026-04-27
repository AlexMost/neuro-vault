import { invokeTool } from '../../lib/tool-response.js';
import { registerTool } from '../../lib/tool-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import { buildFindDuplicatesTool } from './tools/find-duplicates.js';
import { buildGetSimilarNotesTool } from './tools/get-similar-notes.js';
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
    {
      name: 'get_stats',
      spec: {
        title: 'Get Stats',
        description: 'Report corpus and embedding statistics.',
      },
      handler: async () => invokeTool(() => handlers.getStats()),
    },
  ];
}
