import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { SmartSource, ToolStats } from '../types.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';

const inputSchema = z.object({
  vault: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface GetStatsDeps {
  registry: VaultRegistry;
  modelKey: string;
}

function readEmbeddingDimension(sources: Iterable<SmartSource>): number {
  let dimension: number | undefined;
  for (const source of sources) {
    if (dimension === undefined) {
      dimension = source.embedding.length;
      continue;
    }
    if (source.embedding.length !== dimension) {
      throw new ToolHandlerError(
        'DEPENDENCY_ERROR',
        'Loaded corpus contains mixed embedding dimensions',
        {
          details: {
            expectedDimension: dimension,
            actualDimension: source.embedding.length,
            path: source.path,
          },
        },
      );
    }
  }
  return dimension ?? 0;
}

export function buildGetStatsTool(deps: GetStatsDeps): ITool<Input, { vault: string } & ToolStats> {
  const { registry, modelKey } = deps;
  return {
    name: 'get_stats',
    title: 'Get Stats',
    description:
      'Report corpus and embedding statistics. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, {
        tool: 'get_stats',
        requireSemantic: true,
      });
      // resolveVault with requireSemantic: true guarantees entry.corpus is defined
      const corpus = entry.corpus!;
      try {
        const { sources } = await corpus.snapshot();
        let totalBlocks = 0;
        for (const source of sources.values()) {
          totalBlocks += source.blocks.length;
        }
        return {
          vault: entry.name,
          totalNotes: sources.size,
          totalBlocks,
          embeddingDimension: readEmbeddingDimension(sources.values()),
          modelKey,
        };
      } catch (error) {
        if (error instanceof ToolHandlerError) throw error;
        throw new ToolHandlerError('DEPENDENCY_ERROR', 'Failed to get corpus stats', {
          details: { modelKey, operation: 'get_stats' },
          cause: error,
        });
      }
    },
  };
}
