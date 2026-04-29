import { ToolHandlerError } from '../../lib/tool-response.js';
import { normalizeVaultPath } from '../../lib/obsidian/paths.js';

export const MAX_MULTI_QUERIES = 8;

export function normalizeNotePath(notePath: string): string {
  try {
    return normalizeVaultPath(notePath);
  } catch (err) {
    throw new ToolHandlerError('INVALID_ARGUMENT', (err as Error).message, {
      details: { field: 'path' },
    });
  }
}

export function normalizeQuery(query: string): string {
  const normalized = query.trim();

  if (normalized.length === 0) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'query must not be empty', {
      details: { field: 'query' },
    });
  }

  return normalized;
}

export function normalizeQueryArray(queries: string[]): string[] {
  if (queries.length === 0) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'query array must not be empty', {
      details: { field: 'query' },
    });
  }
  if (queries.length > MAX_MULTI_QUERIES) {
    throw new ToolHandlerError(
      'INVALID_ARGUMENT',
      `query array must contain at most ${MAX_MULTI_QUERIES} entries`,
      { details: { field: 'query', max: MAX_MULTI_QUERIES, received: queries.length } },
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of queries) {
    if (typeof raw !== 'string') {
      throw new ToolHandlerError('INVALID_ARGUMENT', 'query array must contain strings', {
        details: { field: 'query' },
      });
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new ToolHandlerError('INVALID_ARGUMENT', 'query entries must not be empty', {
        details: { field: 'query' },
      });
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function readPositiveInteger(
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

export function readThreshold(
  value: number | undefined,
  defaultValue: number,
  field: string,
): number {
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
