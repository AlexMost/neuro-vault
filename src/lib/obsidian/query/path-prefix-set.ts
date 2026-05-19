import { ToolHandlerError } from '../../tool-response.js';
import { ScanPathNotFoundError } from '../vault-reader.js';
import { normalizeVaultPathPrefix } from './path-prefix.js';

export type PrefixInput = string | string[] | undefined;
export type PrefixField = 'path_prefix' | 'exclude_path_prefix';
export type PrefixErrorCode = 'INVALID_FILTER' | 'INVALID_PARAMS';

export function normalizePrefixList(
  raw: PrefixInput,
  field: PrefixField,
  errorCode: PrefixErrorCode,
): string[] | undefined {
  if (raw === undefined) return undefined;

  const invalid = (message: string): ToolHandlerError =>
    new ToolHandlerError(errorCode, message, { details: { field } });

  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw invalid(`${field} must contain at least one prefix`);
    }
    const out = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string') {
        throw invalid(`${field} elements must be strings`);
      }
      const normalized = normalizeVaultPathPrefix(entry, invalid);
      if (normalized !== undefined) out.add(normalized);
    }
    return out.size === 0 ? undefined : [...out];
  }

  if (typeof raw !== 'string') {
    throw invalid(`${field} must be a string or array of strings`);
  }
  const normalized = normalizeVaultPathPrefix(raw, invalid);
  return normalized === undefined ? undefined : [normalized];
}

export function matchesAnyPrefix(p: string, prefixes: string[]): boolean {
  for (const q of prefixes) {
    if (p === q) return true;
    if (p.startsWith(`${q}/`)) return true;
  }
  return false;
}

/**
 * Re-throws a path-not-found error with `path_prefix[i]` framing when the
 * caller is in multi-prefix mode. Single-prefix callers see the unchanged
 * `path_prefix not found: <prefix>` message that {@link ScanPathNotFoundError}
 * has produced since before this feature shipped. The helper accepts either a
 * raw `ScanPathNotFoundError` (fast path, before wrapping) or a wrapped
 * `ToolHandlerError('PATH_NOT_FOUND')` (general path, after
 * `collectMatchingPaths` has already wrapped) so both call sites use the same
 * enrichment logic. Any other error is re-thrown untouched.
 */
export function rethrowPathNotFoundWithIndex(
  err: unknown,
  prefix: string,
  index: number,
  total: number,
): never {
  const isRaw = err instanceof ScanPathNotFoundError;
  const isWrapped = err instanceof ToolHandlerError && err.code === 'PATH_NOT_FOUND';
  if (!isRaw && !isWrapped) {
    throw err;
  }
  if (total <= 1) {
    if (isRaw) {
      throw new ToolHandlerError('PATH_NOT_FOUND', err.message);
    }
    throw err;
  }
  throw new ToolHandlerError(
    'PATH_NOT_FOUND',
    `path_prefix[${index}] not found: ${JSON.stringify(prefix)}`,
    { details: { path_prefix: prefix, index } },
  );
}
