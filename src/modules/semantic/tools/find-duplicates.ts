import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { resolveSemanticVault } from '../../../lib/resolve-vault.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair, SearchEngine } from '../types.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import {
  describeMultiVault,
  EXPLICIT_VAULT_SUFFIX,
  vaultParamShape,
} from '../../../lib/vault-param.js';

const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

interface Input {
  vault?: string;
  threshold?: number;
}

type StampedDuplicatePair = DuplicatePair & { vault: string };

export interface FindDuplicatesDeps {
  registry: IVaultRegistry;
  searchEngine: SearchEngine;
  modelKey: string;
}

export function buildFindDuplicatesTool(
  deps: FindDuplicatesDeps,
): ITool<Input, StampedDuplicatePair[]> {
  const { registry, searchEngine, modelKey } = deps;
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    threshold: z.number().min(0).max(1).optional(),
  });
  return {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description:
      'Identify note pairs with high embedding similarity.' +
      describeMultiVault(registry, EXPLICIT_VAULT_SUFFIX),
    inputSchema,
    handler: async (input) => {
      const entry = resolveSemanticVault(input, registry, {
        tool: 'find_duplicates',
      });
      const corpus = entry.corpus;
      const threshold = readThreshold(input.threshold, DEFAULT_DUPLICATE_THRESHOLD, 'threshold');
      try {
        const { sources } = await corpus.snapshot();
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
  };
}
