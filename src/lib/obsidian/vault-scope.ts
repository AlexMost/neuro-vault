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
   * handles via `dot: false`). Frozen and readonly: the same pattern list
   * backs the compiled predicate, so a mutation would desync the two views.
   */
  ignorePatterns: readonly string[];
  /** Authoritative membership test for a vault-relative POSIX path. */
  isExcluded(relPath: string): boolean;
}

export interface VaultScopeInput {
  /** Raw lines of the vault root's `.gitignore`; omit when the file is absent. */
  gitignoreLines?: string[];
  /** Globs from `.neuro-vault/config.json` `"exclusions"`, unioned with defaults. */
  configExclusions?: string[];
  /** Defaults to stderr — stdout is the MCP transport and must stay clean. */
  warn?: (message: string) => void;
}

const DEFAULT_EXCLUDED_DIRS = ['Templates'];

/**
 * Gitignore lines that name the whole vault. The allowlist idiom (`*` followed
 * by `!Notes/`) cannot work here — negation lines are skipped by design (D4) —
 * so it silently blanks discovery unless the scope builder says something.
 */
const CATCH_ALL_GITIGNORE_LINES = new Set(['*', '**', '/']);

/**
 * Reject patterns picomatch cannot take as a plain exclusion: an empty entry
 * makes it throw ("Expected pattern to be a non-empty string"), and a leading
 * `!` is picomatch's own negation operator, which would invert the whole
 * predicate instead of adding an exclusion — union-only is the contract
 * (design D2), and fast-glob's `ignore` reads `!` the other way round, so a
 * negated entry would also split the two views.
 */
export function isUsableExclusionPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return trimmed !== '' && !trimmed.startsWith('!');
}

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
  const warn = input.warn ?? ((message: string) => console.error(message));

  const gitignoreLines = input.gitignoreLines ?? [];
  for (const raw of gitignoreLines) {
    const line = raw.trim();
    if (!CATCH_ALL_GITIGNORE_LINES.has(line)) continue;
    warn(
      `neuro-vault: root .gitignore entry "${line}" names the whole vault, and negation ("!") ` +
        `lines are not honoured — discovery may return no notes. ` +
        `See docs/architecture/vault-scope.md.`,
    );
  }

  // Defence in depth: the parse boundary already drops unusable entries with a
  // warning naming the offender, but this module must never throw regardless
  // of caller — a throw here would reject VaultRegistry.create and take a
  // whole multi-vault server down over one vault's config typo.
  const patterns = [
    ...DEFAULT_EXCLUDED_DIRS.flatMap((d) => [d, `${d}/**`]),
    ...gitignoreLinesToPatterns(gitignoreLines),
    ...(input.configExclusions ?? []),
  ].filter(isUsableExclusionPattern);

  const matches = picomatch(patterns, { dot: true });
  return {
    ignorePatterns: Object.freeze([...patterns]),
    isExcluded(relPath: string): boolean {
      return hasDotSegment(relPath) || matches(relPath);
    },
  };
}
