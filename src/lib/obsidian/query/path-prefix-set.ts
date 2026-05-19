import { ToolHandlerError } from '../../tool-response.js';
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
