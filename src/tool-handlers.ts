import path from 'node:path';

import type {
  DuplicatePair,
  FindDuplicatesInput,
  GetSimilarNotesInput,
  SearchEngine,
  SearchNotesInput,
  SearchResult,
  SmartSource,
  ToolHandlerDependencies,
  ToolHandlerErrorCode,
  ToolHandlers,
  ToolStats,
} from './types.js';

const DEFAULT_SEARCH_LIMIT = 10;
const DEFAULT_SEARCH_THRESHOLD = 0.5;
const DEFAULT_DUPLICATE_THRESHOLD = 0.9;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

export class ToolHandlerError extends Error {
  readonly code: ToolHandlerErrorCode;

  readonly details?: Record<string, unknown>;

  constructor(
    code: ToolHandlerErrorCode,
    message: string,
    options?: {
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ToolHandlerError';
    this.code = code;
    this.details = options?.details;

    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

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

  if (!normalized) {
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

export function createToolHandlers({
  loader,
  embeddingProvider,
  searchEngine,
  modelKey,
}: ToolHandlerDependencies): ToolHandlers {
  return {
    async searchNotes(input: SearchNotesInput): Promise<SearchResult[]> {
      const query = normalizeQuery(input.query);
      const limit = readPositiveInteger(input.limit, DEFAULT_SEARCH_LIMIT, 'limit');
      const threshold = readThreshold(input.threshold, DEFAULT_SEARCH_THRESHOLD, 'threshold');

      let queryVector: number[];

      try {
        queryVector = await embeddingProvider.embed(query);
      } catch (error) {
        throw wrapDependencyError(error, 'Failed to embed query text', {
          modelKey,
          operation: 'search_notes',
        });
      }

      try {
        return toSearchResults(
          searchEngine,
          queryVector,
          loader.sources.values(),
          threshold,
          limit,
        );
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
        return toSearchResults(
          searchEngine,
          source.embedding,
          loader.sources.values(),
          threshold,
          limit,
          notePath,
        );
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
        return searchEngine.findDuplicates({
          sources: loader.sources.values(),
          threshold,
        });
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
