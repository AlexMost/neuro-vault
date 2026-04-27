import {
  executeRetrieval,
  executeMultiRetrieval,
  type MultiRetrievalOutput,
  type RetrievalOutput,
} from './retrieval-policy.js';
import {
  normalizeNotePath,
  normalizeQuery,
  normalizeQueryArray,
  readPositiveInteger,
  readThreshold,
} from './tool-helpers.js';
import type {
  DuplicatePair,
  FindDuplicatesInput,
  GetSimilarNotesInput,
  PathExistsCheck,
  SearchEngine,
  SearchNotesInput,
  SearchResult,
  SmartSource,
  ToolHandlerDependencies,
  ToolHandlers,
  ToolStats,
} from './types.js';
import { ToolHandlerError } from '../../lib/tool-response.js';

export { ToolHandlerError } from '../../lib/tool-response.js';

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_THRESHOLD = 0.5;
const DEFAULT_DUPLICATE_THRESHOLD = 0.9;

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

function toSearchResults(
  searchEngine: SearchEngine,
  queryVector: number[],
  sources: Iterable<SmartSource>,
  threshold: number,
  limit: number,
  excludePath?: string,
): SearchResult[] {
  return searchEngine.findNeighbors({
    queryVector,
    sources,
    threshold,
    limit,
    excludePath,
  });
}

function wrapDependencyError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): ToolHandlerError {
  if (error instanceof ToolHandlerError) {
    return error;
  }

  return new ToolHandlerError('DEPENDENCY_ERROR', message, {
    details,
    cause: error,
  });
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

export function createToolHandlers({
  loader,
  embeddingProvider,
  searchEngine,
  modelKey,
  pathExists,
}: ToolHandlerDependencies): ToolHandlers {
  const existsCheck: PathExistsCheck = pathExists ?? (async () => true);
  return {
    async searchNotes(input: SearchNotesInput): Promise<RetrievalOutput | MultiRetrievalOutput> {
      const mode = input.mode ?? 'quick';
      const threshold =
        input.threshold !== undefined
          ? readThreshold(input.threshold, input.threshold, 'threshold')
          : undefined;
      const limit =
        input.limit !== undefined
          ? readPositiveInteger(input.limit, input.limit, 'limit')
          : undefined;

      if (Array.isArray(input.query)) {
        const queries = normalizeQueryArray(input.query);

        try {
          const output = await executeMultiRetrieval({
            queries,
            mode,
            threshold,
            limit,
            sources: loader.sources,
            embeddingProvider,
            searchEngine,
          });

          const candidatePaths: string[] = [
            ...output.results.map((r) => r.path),
            ...(output.blockResults?.map((b) => b.path) ?? []),
          ];
          const existing = await buildExistingPathSet(candidatePaths, existsCheck);

          return {
            results: output.results.filter((r) => existing.has(r.path)),
            ...(output.blockResults !== undefined
              ? { blockResults: output.blockResults.filter((b) => existing.has(b.path)) }
              : {}),
            truncated: output.truncated,
          };
        } catch (error) {
          throw wrapDependencyError(error, 'Failed to search notes', {
            modelKey,
            operation: 'search_notes',
          });
        }
      }

      const query = normalizeQuery(input.query);

      try {
        const output = await executeRetrieval({
          query,
          mode,
          limit,
          threshold,
          sources: loader.sources,
          embeddingProvider,
          searchEngine,
        });

        const candidatePaths: string[] = [
          ...output.results.map((r) => r.path),
          ...(output.blockResults?.map((b) => b.path) ?? []),
        ];
        const existing = await buildExistingPathSet(candidatePaths, existsCheck);

        return {
          results: output.results.filter((r) => existing.has(r.path)),
          ...(output.blockResults !== undefined
            ? { blockResults: output.blockResults.filter((b) => existing.has(b.path)) }
            : {}),
        };
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to search notes', {
          modelKey,
          operation: 'search_notes',
        });
      }
    },

    async getSimilarNotes(input: GetSimilarNotesInput): Promise<SearchResult[]> {
      const notePath = normalizeNotePath(input.path);
      const source = loader.sources.get(notePath);

      if (!source) {
        throw new ToolHandlerError('NOT_FOUND', `No note found for path: ${notePath}`, {
          details: { path: notePath },
        });
      }

      const limit = readPositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, 'limit');
      const threshold = readThreshold(input.threshold, DEFAULT_SEARCH_THRESHOLD, 'threshold');

      try {
        const results = toSearchResults(
          searchEngine,
          source.embedding,
          loader.sources.values(),
          threshold,
          limit,
          notePath,
        );
        const existing = await buildExistingPathSet(
          results.map((r) => r.path),
          existsCheck,
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

    async findDuplicates(input: FindDuplicatesInput = {}): Promise<DuplicatePair[]> {
      const threshold = readThreshold(input.threshold, DEFAULT_DUPLICATE_THRESHOLD, 'threshold');

      try {
        const pairs = searchEngine.findDuplicates({
          sources: loader.sources.values(),
          threshold,
        });
        const existing = await buildExistingPathSet(
          pairs.flatMap((p) => [p.note_a, p.note_b]),
          existsCheck,
        );
        return pairs.filter((p) => existing.has(p.note_a) && existing.has(p.note_b));
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to find duplicate notes', {
          modelKey,
          operation: 'find_duplicates',
        });
      }
    },

    async getStats(): Promise<ToolStats> {
      let totalBlocks = 0;

      for (const source of loader.sources.values()) {
        totalBlocks += source.blocks.length;
      }

      return {
        totalNotes: loader.sources.size,
        totalBlocks,
        embeddingDimension: readEmbeddingDimension(loader.sources.values()),
        modelKey,
      };
    },
  };
}
