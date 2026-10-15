/**
 * Resolves a wikilink target (or a name-addressed tool input) to vault-relative
 * note paths. Resolution order, first hit wins:
 *
 * 1. exact path — the target names an existing file verbatim or with `.md` appended;
 * 2. unique suffix — a path-form target (`Folder/Note`) with no exact match resolves
 *    when exactly one note path ends with `/Folder/Note.md`, the way Obsidian
 *    resolves a link written relative to a non-root folder; several candidates
 *    leave `resolve()` null (ambiguous) while `resolveAll()` lists them;
 * 3. basename — a bare target matches every note with that basename; `resolve()`
 *    keeps the lexicographically smallest path, `resolveAll()` lists them.
 *
 * Documented in `docs/architecture/note-path-resolution.md`.
 */
export interface BasenameIndex {
  /**
   * The resolved path, or `null` when nothing matches or when a path-form
   * target is ambiguous by suffix.
   */
  resolve(target: string): string | null;
  /** Every candidate, sorted; empty when nothing matches. */
  resolveAll(target: string): string[];
}

export function buildBasenameIndex(paths: Iterable<string>): BasenameIndex {
  const exact = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();

  for (const p of paths) {
    exact.add(p);
    push(byBasename, baseOf(p), p);
    for (const suffix of properSuffixes(p)) push(bySuffix, suffix, p);
  }

  for (const list of byBasename.values()) list.sort();
  for (const list of bySuffix.values()) list.sort();

  function resolveAll(target: string): string[] {
    if (!target) return [];

    if (target.includes('/')) {
      if (exact.has(target)) return [target];
      const withMd = target.endsWith('.md') ? target : `${target}.md`;
      if (exact.has(withMd)) return [withMd];
      const bySuffixMatches = bySuffix.get(stripMd(target));
      return bySuffixMatches ? [...bySuffixMatches] : [];
    }

    const matches = byBasename.get(stripMd(target));
    return matches ? [...matches] : [];
  }

  return {
    resolve(target: string): string | null {
      const all = resolveAll(target);
      if (all.length === 0) return null;
      // A path-form target matching several notes by suffix is ambiguous:
      // Obsidian would need the fuller path, so stay unresolved rather than
      // guess. Bare basenames keep the first-match behaviour.
      if (all.length > 1 && target.includes('/')) return null;
      return all[0];
    },
    resolveAll,
  };
}

function push(index: Map<string, string[]>, key: string, path: string): void {
  const list = index.get(key);
  if (list) {
    list.push(path);
  } else {
    index.set(key, [path]);
  }
}

function stripMd(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  return stripMd(tail);
}

/**
 * Every strict `/`-delimited tail of `path` that still contains a `/`,
 * `.md` stripped: `A/B/C.md` → `B/C`. The bare basename is left to
 * `byBasename`; the full path to `exact`.
 */
function properSuffixes(path: string): string[] {
  const stripped = stripMd(path);
  const out: string[] = [];
  let slash = stripped.indexOf('/');
  while (slash >= 0) {
    const tail = stripped.slice(slash + 1);
    if (tail.includes('/')) out.push(tail);
    slash = stripped.indexOf('/', slash + 1);
  }
  return out;
}
