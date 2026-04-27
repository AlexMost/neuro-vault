import { z } from 'zod';

import { invokeTool } from '../../lib/tool-response.js';
import { registerTool } from '../../lib/tool-registry.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import { buildGetSimilarNotesTool } from './tools/get-similar-notes.js';
import { buildSearchNotesTool, type SearchNotesDeps } from './tools/search-notes.js';
import type { ToolHandlers } from './types.js';

const findDuplicatesSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
});

export function buildSemanticTools(
  handlers: ToolHandlers,
  deps: SearchNotesDeps,
): ToolRegistration[] {
  return [
    registerTool(buildSearchNotesTool(deps)),
    registerTool(buildGetSimilarNotesTool(deps)),
    {
      name: 'find_duplicates',
      spec: {
        title: 'Find Duplicates',
        description: 'Identify note pairs with high embedding similarity.',
        inputSchema: findDuplicatesSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.findDuplicates(findDuplicatesSchema.parse(args))),
    },
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
