export interface BasenameIndex {
  resolve(target: string): string | null;
  resolveAll(target: string): string[];
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

  function resolveAll(target: string): string[] {
    if (!target) return [];

    if (target.includes('/')) {
      if (exact.has(target)) return [target];
      const withMd = target.endsWith('.md') ? target : `${target}.md`;
      if (exact.has(withMd)) return [withMd];
      return [];
    }

    const key = target.endsWith('.md') ? target.slice(0, -3) : target;
    const matches = byBasename.get(key);
    return matches ? [...matches] : [];
  }

  return {
    resolve(target: string): string | null {
      const all = resolveAll(target);
      return all.length > 0 ? all[0]! : null;
    },
    resolveAll,
  };
}

function baseOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash >= 0 ? path.slice(slash + 1) : path;
  return tail.endsWith('.md') ? tail.slice(0, -3) : tail;
}
