import path from 'node:path';

import { executeRetrieval, type RetrievalOutput } from './retrieval-policy.js';
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
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function normalizeNotePath(notePath: string): string {
  const trimmed = notePath.trim();

  if (!trimmed) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'note_path must not be empty', {
      details: { field: 'note_path' },
    });
  }

  if (path.posix.isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'note_path must be vault-relative', {
      details: { field: 'note_path' },
    });
  }

  const slashNormalized = trimmed.replace(/\\/g, '/');

  if (slashNormalized.split('/').some((segment) => segment === '..')) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'note_path must be vault-relative', {
      details: { field: 'note_path' },
    });
  }

  const normalized = path.posix.normalize(slashNormalized);

  if (normalized === '.') {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'note_path must not be empty', {
      details: { field: 'note_path' },
    });
  }

  if (path.posix.isAbsolute(normalized)) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'note_path must be vault-relative', {
      details: { field: 'note_path' },
    });
  }

  return normalized;
}

function normalizeQuery(query: string): string {
  const normalized = query.trim();

  if (normalized.length === 0) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'query must not be empty', {
      details: { field: 'query' },
    });
  }

  return normalized;
}

function readPositiveInteger(
  value: number | undefined,
  defaultValue: number,
  field: string,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new ToolHandlerError('INVALID_ARGUMENT', `${field} must be a positive integer`, {
      details: { field },
    });
  }

  return value;
}

function readThreshold(value: number | undefined, defaultValue: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isFinite(value)) {
    throw new ToolHandlerError('INVALID_ARGUMENT', `${field} must be a finite number`, {
      details: { field },
    });
  }

  if (value < 0 || value > 1) {
    throw new ToolHandlerError('INVALID_ARGUMENT', `${field} must be between 0 and 1`, {
      details: { field },
    });
  }

  return value;
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
    async searchNotes(input: SearchNotesInput): Promise<RetrievalOutput> {
      // TODO(multi-query): replaced by Array.isArray branching in a follow-up commit.
      const query = normalizeQuery(input.query as string);
      const mode = input.mode ?? 'quick';
      const threshold =
        input.threshold !== undefined
          ? readThreshold(input.threshold, input.threshold, 'threshold')
          : undefined;
      const expansionLimit =
        input.expansion_limit !== undefined
          ? readPositiveInteger(input.expansion_limit, 3, 'expansion_limit')
          : undefined;

      try {
        const output = await executeRetrieval({
          query,
          mode,
          threshold,
          expansion: input.expansion,
          expansionLimit,
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
      const notePath = normalizeNotePath(input.note_path);
      const source = loader.sources.get(notePath);

      if (!source) {
        throw new ToolHandlerError('NOT_FOUND', `No note found for path: ${notePath}`, {
          details: { note_path: notePath },
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
          note_path: notePath,
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
