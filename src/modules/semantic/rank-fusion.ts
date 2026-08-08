import type { NoteResultNode } from './types.js';

// RRF over three tiny (≤10-item) rank lists. k is adaptive to vault size:
// canonical k=60 collapses within-source position at these list lengths.
const K_MIN = 5;
const K_MAX = 60;

export function adaptiveK(totalNotes: number): number {
  return Math.min(K_MAX, Math.max(K_MIN, Math.round(Math.sqrt(totalNotes))));
}

export interface ExpansionCandidate {
  path: string;
  expansion_similarity: number;
}

export function flattenExpansion(seeds: NoteResultNode[]): ExpansionCandidate[] {
  const seedPaths = new Set(seeds.map((s) => s.path));
  const best = new Map<string, number>();
  for (const s of seeds)
    for (const rel of s.related) {
      if (seedPaths.has(rel.path)) continue;
      const prev = best.get(rel.path);
      if (prev === undefined || rel.expansion_similarity > prev)
        best.set(rel.path, rel.expansion_similarity);
    }
  return [...best.entries()]
    .map(([path, expansion_similarity]) => ({ path, expansion_similarity }))
    .sort(
      (a, b) => b.expansion_similarity - a.expansion_similarity || a.path.localeCompare(b.path),
    );
}

export interface FusedCandidate {
  path: string;
  score: number;
  sourceCount: number;
}

export function fuseRanks(args: {
  sources: { semantic: string[]; lexical: string[]; expansion: string[] };
  totalNotes: number;
  getBacklinkCount: (path: string) => number;
}): FusedCandidate[] {
  const k = adaptiveK(args.totalNotes);
  const acc = new Map<string, FusedCandidate>();
  for (const ordered of [args.sources.semantic, args.sources.lexical, args.sources.expansion]) {
    ordered.forEach((path, i) => {
      const cand = acc.get(path) ?? { path, score: 0, sourceCount: 0 };
      cand.score += 1 / (k + i + 1);
      cand.sourceCount += 1;
      acc.set(path, cand);
    });
  }
  return [...acc.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.sourceCount - a.sourceCount ||
      args.getBacklinkCount(b.path) - args.getBacklinkCount(a.path) ||
      a.path.localeCompare(b.path),
  );
}
