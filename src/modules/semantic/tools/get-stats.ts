import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import type { SmartSource, ToolStats } from '../types.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface GetStatsDeps {
  sources: Map<string, SmartSource>;
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

export function buildGetStatsTool(deps: GetStatsDeps): ITool<Input, ToolStats> {
  const { sources, modelKey } = deps;
  return {
    name: 'get_stats',
    title: 'Get Stats',
    description: 'Report corpus and embedding statistics.',
    inputSchema,
    handler: async () => {
      let totalBlocks = 0;
      for (const source of sources.values()) {
        totalBlocks += source.blocks.length;
      }
      return {
        totalNotes: sources.size,
        totalBlocks,
        embeddingDimension: readEmbeddingDimension(sources.values()),
        modelKey,
      };
    },
  };
}
