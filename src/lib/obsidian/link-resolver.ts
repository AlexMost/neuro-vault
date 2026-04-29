export interface BasenameIndex {
  resolve(target: string): string | null;
}

export function buildBasenameIndex(paths: Iterable<string>): BasenameIndex {
  const exact = new Set<string>();
  const byBasename = new Map<string, string[]>();

  for (const p of paths) {
    exact.add(p);
    const basename = baseOf(p);
    const list = byBasename.get(basename);
    if (list) {
      list.push(p);
    } else {
      byBasename.set(basename, [p]);
    }
  }

  for (const list of byBasename.values()) {
    list.sort();
  }

  return {
    resolve(target: string): string | null {
      if (!target) return null;

      if (target.includes('/')) {
        if (exact.has(target)) return target;
        const withMd = target.endsWith('.md') ? target : `${target}.md`;
        if (exact.has(withMd)) return withMd;
        return null;
      }

      const key = target.endsWith('.md') ? target.slice(0, -3) : target;
      const matches = byBasename.get(key);
      return matches && matches.length > 0 ? matches[0] : null;
    },
  };
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  return tail.endsWith('.md') ? tail.slice(0, -3) : tail;
}
