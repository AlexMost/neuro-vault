import { z } from 'zod';

import { invokeTool } from '../../lib/tool-response.js';
import type { ToolRegistration } from '../../lib/tool-registration.js';
import type { ToolHandlers } from './types.js';

const searchNotesSchema = z.object({
  query: z.union([z.string(), z.array(z.string()).min(1).max(8)]),
  mode: z.enum(['quick', 'deep']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const getSimilarNotesSchema = z.object({
  path: z.string(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const findDuplicatesSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
});

export function buildSemanticTools(handlers: ToolHandlers): ToolRegistration[] {
  return [
    {
      name: 'search_notes',
      spec: {
        title: 'Search Notes',
        description:
          'Search notes by semantic similarity for fuzzy recall, topic lookup, or cross-language matching. Pass a short keyword query (1-4 words). For synonyms, reformulations, or translations into the languages used in the vault, pass an array of 1-8 queries — they are batch-embedded server-side and returned as one merged ranked list with matched_queries on each result. Choose mode: "quick" for specific lookups (up to 3 notes), "deep" for broad topic overview with block-level search and expansion.',
        inputSchema: searchNotesSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.searchNotes(searchNotesSchema.parse(args))),
    },
    {
      name: 'get_similar_notes',
      spec: {
        title: 'Get Similar Notes',
        description:
          'Find semantically related notes after you already have a relevant note path. Pass a vault-relative POSIX path (e.g. "Folder/note.md") as `path`.',
        inputSchema: getSimilarNotesSchema,
      },
      handler: async (args) =>
        invokeTool(() => handlers.getSimilarNotes(getSimilarNotesSchema.parse(args))),
    },
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
