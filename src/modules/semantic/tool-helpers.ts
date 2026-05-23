import fs from 'node:fs/promises';
import path from 'node:path';

import { ToolHandlerError } from '../../lib/tool-response.js';
import type { IVaultEntry } from '../../lib/vault-registry.js';

export async function pathExistsForEntry(
  entry: IVaultEntry,
  vaultRelativePath: string,
): Promise<boolean> {
  try {
    await fs.access(path.join(entry.path, vaultRelativePath));
    return true;
  } catch {
    return false;
  }
}

export function readNoteContentForEntry(
  entry: IVaultEntry,
  vaultRelativePath: string,
): Promise<string> {
  return fs.readFile(path.join(entry.path, vaultRelativePath), 'utf8');
}

export const MAX_MULTI_QUERIES = 8;

// `normalizeNotePath` lives in `src/lib/obsidian/note-path.ts` and auto-appends
// `.md` for note paths. Semantic tools that take a single-note path import it
// from there directly — see `get-similar-notes.ts`. We do NOT re-export a
// non-promoting variant from this module because the name would collide with
// the canonical one and silently produce different behavior.

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
