import fs from 'node:fs/promises';
import path from 'node:path';

import { CorpusNotReadyError } from '../../lib/obsidian/semantic-backend.js';
import { ToolHandlerError } from '../../lib/tool-response.js';
import type { IRegisteredVault } from '../../lib/vault-registry.js';

export function readNoteContentForEntry(
  entry: IRegisteredVault,
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

/**
 * An unexpected dependency failure as `DEPENDENCY_ERROR`, keeping the cause and adding the
 * operation context to `details`. A `ToolHandlerError` passes through as already shaped, and so
 * does a `CorpusNotReadyError`: a corpus that stopped serving after the readiness gate let the
 * call in is the dispatcher's to report, as the gate would.
 */
export function wrapDependencyError(
  error: unknown,
  message: string,
  details: Record<string, unknown>,
): ToolHandlerError | CorpusNotReadyError {
  if (error instanceof ToolHandlerError || error instanceof CorpusNotReadyError) return error;
  return new ToolHandlerError('DEPENDENCY_ERROR', message, { details, cause: error });
}
