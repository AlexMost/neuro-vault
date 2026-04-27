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
        description: [
          'Search notes by semantic similarity. Best for fuzzy recall, topic exploration, or cross-language matches. Pass short keyword queries (1-4 words), not sentences.',
          '',
          'MODES (pick based on intent):',
          '- "quick" (default) — specific lookup. Returns up to 3 top notes plus block-level matches scoped to those notes. Use when you want one or two specific notes.',
          '- "deep" — topic exploration. Returns up to 8 notes plus block-level matches across the whole vault, with semantic expansion to related notes. Use for "tell me about X" or building an overview.',
          '',
          'PARAMETERS:',
          '- query (required): string, or array of 1-8 strings. Pass an array for synonyms / reformulations / translations — embedded in batch and merged into one ranked list with `matched_queries` per result.',
          '- mode: "quick" | "deep" (default "quick").',
          '- limit: max notes in `results`. Default 3 (quick) / 8 (deep). Override to widen or narrow the result set. Does not affect `blockResults` (quick: capped at 5; deep: capped at mode limit).',
          '- threshold: min similarity, 0-1. Default 0.5 (quick) / 0.35 (deep). Raise to 0.6+ to cut weak matches; lower (e.g. 0.3) when nothing comes back.',
          '',
          'EXAMPLES:',
          '- "where did I write about X?" → search_notes({query: "X"}) — quick.',
          '- "what do I know about Y?" → search_notes({query: "Y", mode: "deep"}).',
          '- multilingual: search_notes({query: ["embeddings", "векторний пошук"]}).',
        ].join('\n'),
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
