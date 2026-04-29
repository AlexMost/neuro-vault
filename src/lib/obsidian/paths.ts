import path from 'node:path';

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

/**
 * Convert backslash-separated path to forward-slash-separated. No validation.
 * Use when you only need `\` → `/` (e.g. operating on a path *segment* during
 * filesystem scanning). For full validation use `normalizeVaultPath`.
 */
export function toPosixSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Validate and normalize a vault-relative POSIX path. Throws a plain `Error`
 * on failure. Tool-handler wrappers translate to `ToolHandlerError` at the
 * MCP layer.
 *
 * Rejects: empty/whitespace, absolute (POSIX or Windows-drive), parent-traversal
 * (`..`), and inputs that normalize to `.` (i.e. `.` and `./`).
 *
 * Strips a leading `./` and runs `path.posix.normalize` to collapse `a/./b`.
 */
export function normalizeVaultPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('path must not be empty');
  }

  if (path.posix.isAbsolute(trimmed) || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    throw new Error('path must be vault-relative');
  }

  const slashed = trimmed.replace(/\\/g, '/');

  if (slashed.split('/').some((segment) => segment === '..')) {
    throw new Error('path must be vault-relative');
  }

  const normalized = path.posix.normalize(slashed);

  if (normalized === '.') {
    throw new Error('path must not be empty');
  }

  if (path.posix.isAbsolute(normalized)) {
    throw new Error('path must be vault-relative');
  }

  const result = normalized.replace(/^\.\//, '');

  if (result === '') {
    throw new Error('path must not be empty');
  }

  return result;
}

/**
 * Normalize an optional vault-subtree prefix. Returns `''` for inputs that
 * mean "the whole vault" (undefined, empty, `.`, `./`). Otherwise slashifies,
 * strips a leading `./`, and strips a trailing `/`.
 *
 * Does **not** validate against absolute paths or `..` traversal — callers
 * apply that validation downstream.
 */
export function normalizeScanPrefix(raw: string | undefined): string {
  if (raw === undefined) return '';
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return '';
  return trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
