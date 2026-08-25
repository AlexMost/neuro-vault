import { access as fsAccess } from 'node:fs/promises';
import path from 'node:path';

/** Injectable existence primitive: resolves if the path is reachable, rejects otherwise. */
export type PathAccess = (absolutePath: string) => Promise<void>;

/**
 * Build this vault's stale-path filter.
 *
 * The corpus can still name a note that was deleted since the last reconcile
 * pass. Every consumer of corpus-derived paths must therefore check disk
 * before answering. That check lives here and nowhere else: the returned
 * closure is bound to one vault root and exposed as
 * `IVaultEntry.filterExisting`.
 *
 * Returns the subset of `paths` that exist. Input is de-duplicated, each path
 * is checked independently, and an unreachable path is reported as absent
 * rather than raising — a missing file is the expected case, not an error.
 */
export function createExistingPathFilter(opts: {
  vaultRoot: string;
  access?: PathAccess;
}): (paths: Iterable<string>) => Promise<Set<string>> {
  const access = opts.access ?? ((absolutePath: string) => fsAccess(absolutePath));
  return async (paths) => {
    const unique = new Set(paths);
    if (unique.size === 0) return new Set();
    const checks = await Promise.all(
      [...unique].map(async (notePath) => {
        try {
          await access(path.join(opts.vaultRoot, notePath));
          return notePath;
        } catch {
          return undefined;
        }
      }),
    );
    return new Set(checks.filter((p): p is string => p !== undefined));
  };
}
