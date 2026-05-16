import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import { pathExistsForEntry } from '../tool-helpers.js';
import { readThreshold } from '../tool-helpers.js';
import type { DuplicatePair, SearchEngine } from '../types.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

const inputSchema = z.object({
  vault: z.string().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

type Input = z.infer<typeof inputSchema>;

type StampedDuplicatePair = DuplicatePair & { vault: string };

export interface FindDuplicatesDeps {
  registry: IVaultRegistry;
  searchEngine: SearchEngine;
  modelKey: string;
}

async function buildExistingPathSet(
  entry: IVaultEntry,
  paths: Iterable<string>,
): Promise<Set<string>> {
  const unique = new Set(paths);
  const checks = await Promise.all(
    [...unique].map(
      async (notePath) => [notePath, await pathExistsForEntry(entry, notePath)] as const,
    ),
  );
  return new Set(checks.filter(([, exists]) => exists).map(([notePath]) => notePath));
}

export function buildFindDuplicatesTool(
  deps: FindDuplicatesDeps,
): ITool<Input, StampedDuplicatePair[]> {
  const { registry, searchEngine, modelKey } = deps;
  return {
    name: 'find_duplicates',
    title: 'Find Duplicates',
    description:
      'Identify note pairs with high embedding similarity. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, {
        tool: 'find_duplicates',
        requireSemantic: true,
      });
      // resolveVault with requireSemantic: true guarantees entry.corpus is defined
      const corpus = entry.corpus!;
      const threshold = readThreshold(input.threshold, DEFAULT_DUPLICATE_THRESHOLD, 'threshold');
      try {
        const { sources } = await corpus.snapshot();
        const pairs = searchEngine.findDuplicates({
          sources: sources.values(),
          threshold,
        });
        const existing = await buildExistingPathSet(
          entry,
          pairs.flatMap((p) => [p.note_a, p.note_b]),
        );
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
