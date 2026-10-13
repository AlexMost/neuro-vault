import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { SimilarityDefaults } from '../model-profiles.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair, SearchEngine } from '../types.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
  threshold?: number;
}

type StampedDuplicatePair = DuplicatePair & { vault: string };

export interface FindDuplicatesDeps {
  registry: IVaultRegistry;
  searchEngine: SearchEngine;
  modelKey: string;
  similarity: SimilarityDefaults;
}

export function buildFindDuplicatesTool(
  deps: FindDuplicatesDeps,
): ITool<Input, StampedDuplicatePair[]> {
  const { registry, searchEngine, modelKey, similarity } = deps;
  return buildSingleVaultTool<Input, StampedDuplicatePair[]>(registry, {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description: 'Identify note pairs with high embedding similarity.',
    semantic: true,
    inputShape: {
      threshold: z.number().min(0).max(1).optional(),
    },
    runForEntry: async (entry, input) => {
      const backend = entry.backend;
      const threshold = readThreshold(input.threshold, similarity.duplicates, 'threshold');
      try {
        const { sources } = await backend.snapshot();
        const pairs = searchEngine.findDuplicates({
          sources: sources.values(),
          threshold,
        });
        const existing = await entry.filterExisting(pairs.flatMap((p) => [p.note_a, p.note_b]));
        return pairs
          .filter((p) => existing.has(p.note_a) && existing.has(p.note_b))
          .map((p) => ({ vault: entry.name, ...p }));
      } catch (error) {
        if (error instanceof ToolHandlerError) throw error;
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'Failed to find duplicate notes', {
          details: { modelKey, operation: 'find_duplicates' },
          cause: error,
        });
      }
    },
  });
}
