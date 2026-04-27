import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair, PathExistsCheck, SearchEngine, SmartSource } from '../types.js';

const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

const inputSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface FindDuplicatesDeps {
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  modelKey: string;
  pathExists: PathExistsCheck;
}

async function buildExistingPathSet(
  paths: Iterable<string>,
  pathExists: PathExistsCheck,
): Promise<Set<string>> {
  const unique = new Set(paths);
  const checks = await Promise.all(
    [...unique].map(async (notePath) => [notePath, await pathExists(notePath)] as const),
  );
  return new Set(checks.filter(([, exists]) => exists).map(([notePath]) => notePath));
}

export function buildFindDuplicatesTool(deps: FindDuplicatesDeps): ITool<Input, DuplicatePair[]> {
  const { sources, searchEngine, modelKey, pathExists } = deps;
  return {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description: 'Identify note pairs with high embedding similarity.',
    inputSchema,
    handler: async (input) => {
      const threshold = readThreshold(input.threshold, DEFAULT_DUPLICATE_THRESHOLD, 'threshold');
      try {
        const pairs = searchEngine.findDuplicates({
          sources: sources.values(),
          threshold,
        });
        const existing = await buildExistingPathSet(
          pairs.flatMap((p) => [p.note_a, p.note_b]),
          pathExists,
        );
        return pairs.filter((p) => existing.has(p.note_a) && existing.has(p.note_b));
      } catch (error) {
        if (error instanceof ToolHandlerError) throw error;
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'Failed to find duplicate notes', {
          details: { modelKey, operation: 'find_duplicates' },
          cause: error,
        });
      }
    },
  };
}
