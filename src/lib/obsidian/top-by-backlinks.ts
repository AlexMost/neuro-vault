import path from 'node:path';

export interface TopBacklinkedNote {
  path: string;
  title: string;
  backlink_count: number;
}

export interface TopByBacklinksInput {
  paths: string[];
  /** One backlink count per path, in order (`IGraphReader.backlinkCounts`). */
  counts: readonly number[];
  limit: number;
}

export function topByBacklinks(input: TopByBacklinksInput): TopBacklinkedNote[] {
  const { paths, counts, limit } = input;
  return paths
    .map((p, i) => ({
      path: p,
      title: basenameWithoutExt(p),
      backlink_count: counts[i] ?? 0,
    }))
    .sort((a, b) =>
      b.backlink_count !== a.backlink_count
        ? b.backlink_count - a.backlink_count
        : a.path.localeCompare(b.path),
    )
    .slice(0, limit);
}

function basenameWithoutExt(notePath: string): string {
  const base = path.posix.basename(notePath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}
