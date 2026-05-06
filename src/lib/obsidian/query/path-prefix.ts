const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

/**
 * Normalize a vault-relative path prefix string. Returns undefined for
 * empty/`.`/`./` (meaning "vault root"). Throws on absolute paths or `..`
 * segments via the supplied error factory so each caller can wrap the
 * failure in its own error code/details.
 */
export function normalizeVaultPathPrefix(
  raw: string,
  invalid: (message: string) => Error,
): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return undefined;
  if (trimmed.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    throw invalid('path_prefix must be vault-relative');
  }
  const slashed = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  if (slashed.split('/').some((segment) => segment === '..')) {
    throw invalid('path_prefix must be vault-relative');
  }
  return slashed.replace(/\/+$/, '');
}
