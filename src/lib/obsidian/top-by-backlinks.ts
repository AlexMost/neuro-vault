import path from 'node:path';

import type { WikilinkGraphIndex } from './wikilink-graph.js';

export interface TopBacklinkedNote {
  path: string;
  title: string;
  backlink_count: number;
}

export interface TopByBacklinksInput {
  paths: string[];
  graph: WikilinkGraphIndex;
  limit: number;
}

export function topByBacklinks(input: TopByBacklinksInput): TopBacklinkedNote[] {
  const { paths, graph, limit } = input;
  return paths
    .map((p) => ({
      path: p,
      title: basenameWithoutExt(p),
      backlink_count: graph.getBacklinkCount(p),
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
