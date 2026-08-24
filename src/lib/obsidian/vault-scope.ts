import picomatch from 'picomatch';

/**
 * The single definition of "which vault files are visible" (capability
 * vault-scope). Scope is discovery, not ACL: read_notes by explicit path
 * bypasses it by design.
 */
export interface VaultScope {
  /**
   * Vault-root-anchored exclusion globs, suitable for fast-glob's `ignore`.
   * A traversal prune only — `isExcluded` is the authoritative test (it also
   * carries the unconditional dot-segment rule, which enumeration already
   * handles via `dot: false`).
   */
  ignorePatterns: string[];
  /** Authoritative membership test for a vault-relative POSIX path. */
  isExcluded(relPath: string): boolean;
}

export interface VaultScopeInput {
  /** Raw lines of the vault root's `.gitignore`; omit when the file is absent. */
  gitignoreLines?: string[];
  /** Globs from `.neuro-vault/config.json` `"exclusions"`, unioned with defaults. */
  configExclusions?: string[];
}

const DEFAULT_EXCLUDED_DIRS = ['Templates'];

/**
 * Minimal gitignore subset (design D4): root file only; blank, comment, and
 * negation lines are skipped; each entry, stripped of leading/trailing
 * slashes, excludes the named path and its whole subtree, anchored at the
 * vault root. Deliberately not git's "match at any level" semantics.
 */
export function gitignoreLinesToPatterns(lines: string[]): string[] {
  const patterns: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
    const entry = line.replace(/^\//, '').replace(/\/$/, '');
    if (entry === '') continue;
    patterns.push(entry, `${entry}/**`);
  }
  return patterns;
}

function hasDotSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

export function createVaultScope(input: VaultScopeInput = {}): VaultScope {
  const patterns = [
    ...DEFAULT_EXCLUDED_DIRS.flatMap((d) => [d, `${d}/**`]),
    ...gitignoreLinesToPatterns(input.gitignoreLines ?? []),
    ...(input.configExclusions ?? []),
  ];
  const matches = picomatch(patterns, { dot: true });
  return {
    ignorePatterns: patterns,
    isExcluded(relPath: string): boolean {
      return hasDotSegment(relPath) || (patterns.length > 0 && matches(relPath));
    },
  };
}
