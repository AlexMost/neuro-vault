import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { normalizeNotePath, readPositiveInteger, readThreshold } from '../tool-helpers.js';
import type {
  EmbeddingProvider,
  PathExistsCheck,
  SearchEngine,
  SearchResult,
  SmartSource,
} from '../types.js';

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.5;

const inputSchema = z.object({
  path: z.string(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface GetSimilarNotesDeps {
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
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

function wrapDependencyError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): ToolHandlerError {
  if (error instanceof ToolHandlerError) return error;
  return new ToolHandlerError('DEPENDENCY_ERROR', message, { details, cause: error });
}

export function buildGetSimilarNotesTool(deps: GetSimilarNotesDeps): ITool<Input, SearchResult[]> {
  const { sources, searchEngine, modelKey, pathExists } = deps;

  return {
    name: 'get_similar_notes',
    title: 'Get Similar Notes',
    description:
      'Find semantically related notes after you already have a relevant note path. Pass a vault-relative POSIX path (e.g. "Folder/note.md") as `path`.',
    inputSchema,
    handler: async (input) => {
      const notePath = normalizeNotePath(input.path);
      const source = sources.get(notePath);
      if (!source) {
        throw new ToolHandlerError('NOT_FOUND', `No note found for path: ${notePath}`, {
          details: { path: notePath },
        });
      }
      const limit = readPositiveInteger(input.limit, DEFAULT_LIMIT, 'limit');
      const threshold = readThreshold(input.threshold, DEFAULT_THRESHOLD, 'threshold');
      try {
        const results = searchEngine.findNeighbors({
          queryVector: source.embedding,
          sources: sources.values(),
          threshold,
          limit,
          excludePath: notePath,
        });
        const existing = await buildExistingPathSet(
          results.map((r) => r.path),
          pathExists,
        );
        return results.filter((r) => existing.has(r.path));
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to find similar notes', {
          modelKey,
          operation: 'get_similar_notes',
          path: notePath,
        });
      }
    },
  };
}
