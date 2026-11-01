import type { ParsedNote } from './blocks.js';
import { matchUnit, type UnitHit } from './match.js';
import { normalizeText, tokenizeQuery } from './normalize.js';
import { makeSnippet } from './snippet.js';

export interface LexicalMatch {
  matched_in: 'title' | 'heading' | 'body';
  snippet: string;
  lines?: [number, number];
  heading?: string;
}

export interface RankedNote {
  path: string;
  matches: LexicalMatch[];
  matchedQueries: string[];
}

interface Candidate {
  path: string;
  tier: number; // 0..5 — best across the note's matches
  density: number; // of the best match
  // `build` defers the snippet (an offset-map rebuild + grapheme pass) until
  // the match survives the noteCap / perNoteCap trim.
  matches: Array<{ tier: number; density: number; key: string; build: () => LexicalMatch }>;
  matchedQueries: Set<string>;
  // Best match per query variant: each variant ranks the notes on its own.
  byQuery: Map<string, { tier: number; density: number }>;
}

/**
 * Query variants are fused by weighted reciprocal rank (#265): each variant
 * ranks its notes on its own, and a note scores `weight / (k + rank)` summed
 * over the variants that matched it. So the title hits of a broad variant
 * cannot push the exact term's body hits out of the pool. The first variant is
 * the caller's own term and weighs more. A single query ranks as before.
 */
export const VARIANT_FUSION_K = 5;
export const FIRST_VARIANT_WEIGHT = 1;
export const OTHER_VARIANT_WEIGHT = 0.5;

// tier = kindBase + (phrase ? 0 : 1); kindBase: title 0, heading 2, body 4
function tierOf(kind: 'title' | 'heading' | 'body', hit: UnitHit): number {
  const base = kind === 'title' ? 0 : kind === 'heading' ? 2 : 4;
  return base + (hit.phrase ? 0 : 1);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.tier - b.tier || b.density - a.density || 0 // backlink/path applied by caller-provided comparator below
  );
}

export function rankNotes(opts: {
  notes: Map<string, ParsedNote>;
  queries: string[];
  noteCap: number;
  perNoteCap: number;
  getBacklinkCount: (path: string) => number;
}): {
  notes: RankedNote[];
  truncated: boolean;
  perQueryCounts: Record<string, number>;
  // Failure-path diagnostic: entries only for queries with zero AND-matches
  // and ≥2 tokens — normalized token → notes where that token alone matches.
  perQueryTokenCounts: Record<string, Record<string, number>>;
} {
  const prepared = opts.queries.map((q) => ({
    original: q,
    norm: normalizeText(q),
    tokens: tokenizeQuery(q),
  }));

  const byPath = new Map<string, Candidate>();

  for (const [notePath, parsed] of opts.notes) {
    for (const q of prepared) {
      if (q.tokens.length === 0) continue;

      const record = (
        kind: 'title' | 'heading' | 'body',
        hit: UnitHit,
        lines: [number, number] | undefined,
        build: () => LexicalMatch,
      ) => {
        const tier = tierOf(kind, hit);
        let cand = byPath.get(notePath);
        if (!cand) {
          cand = {
            path: notePath,
            tier,
            density: hit.density,
            matches: [],
            matchedQueries: new Set(),
            byQuery: new Map(),
          };
          byPath.set(notePath, cand);
        }
        if (tier < cand.tier || (tier === cand.tier && hit.density > cand.density)) {
          cand.tier = tier;
          cand.density = hit.density;
        }
        cand.matchedQueries.add(q.original);
        const best = cand.byQuery.get(q.original);
        if (!best || tier < best.tier || (tier === best.tier && hit.density > best.density)) {
          cand.byQuery.set(q.original, { tier, density: hit.density });
        }
        // avoid duplicate evidence rows across queries for the same location
        const key = `${kind}:${lines?.[0] ?? -1}`;
        if (!cand.matches.some((m) => m.key === key)) {
          cand.matches.push({ tier, density: hit.density, key, build });
        }
      };

      const titleHit = matchUnit(parsed.title.norm, q.norm, q.tokens);
      if (titleHit) {
        record('title', titleHit, undefined, () => ({
          matched_in: 'title',
          snippet: makeSnippet(parsed.title.raw, titleHit.firstIndex, titleHit.matchLen),
        }));
      }

      for (const unit of parsed.units) {
        const hit = matchUnit(unit.norm, q.norm, q.tokens);
        if (!hit) continue;
        record(unit.kind, hit, unit.lines, () => ({
          matched_in: unit.kind,
          snippet: makeSnippet(unit.raw, hit.firstIndex, hit.matchLen),
          lines: unit.lines,
          ...(unit.kind === 'body' && unit.heading !== undefined ? { heading: unit.heading } : {}),
        }));
      }
    }
  }

  const tieBreak = (a: Candidate, b: Candidate) =>
    opts.getBacklinkCount(b.path) - opts.getBacklinkCount(a.path) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  const fused = new Map<Candidate, number>();
  prepared.forEach((q, i) => {
    const weight = i === 0 ? FIRST_VARIANT_WEIGHT : OTHER_VARIANT_WEIGHT;
    const ranked = [...byPath.values()]
      .filter((c) => c.byQuery.has(q.original))
      .sort((a, b) => {
        const qa = a.byQuery.get(q.original)!;
        const qb = b.byQuery.get(q.original)!;
        return qa.tier - qb.tier || qb.density - qa.density || tieBreak(a, b);
      });
    ranked.forEach((c, rank) => {
      fused.set(c, (fused.get(c) ?? 0) + weight / (VARIANT_FUSION_K + rank + 1));
    });
  });

  const candidates = [...byPath.values()].sort(
    (a, b) =>
      (fused.get(b) ?? 0) - (fused.get(a) ?? 0) || compareCandidates(a, b) || tieBreak(a, b),
  );

  const perQueryCounts: Record<string, number> = {};
  for (const q of opts.queries) perQueryCounts[q] = 0;
  for (const cand of candidates)
    for (const q of cand.matchedQueries) perQueryCounts[q] = (perQueryCounts[q] ?? 0) + 1;

  // Per-token counts, only where they explain a zero: a multi-token query
  // that matched nothing gets each token counted individually so the caller
  // sees which token killed the AND.
  const perQueryTokenCounts: Record<string, Record<string, number>> = {};
  for (const q of prepared) {
    if (q.tokens.length < 2 || (perQueryCounts[q.original] ?? 0) !== 0) continue;
    const uniqueTokens = [...new Set(q.tokens)];
    const counts: Record<string, number> = {};
    for (const token of uniqueTokens) counts[token] = 0;
    for (const parsed of opts.notes.values()) {
      for (const token of uniqueTokens) {
        const hit =
          matchUnit(parsed.title.norm, token, [token]) !== null ||
          parsed.units.some((u) => matchUnit(u.norm, token, [token]) !== null);
        if (hit) counts[token] = (counts[token] ?? 0) + 1;
      }
    }
    perQueryTokenCounts[q.original] = counts;
  }

  const truncated = candidates.length > opts.noteCap;
  const selected = candidates.slice(0, opts.noteCap).map((c) => ({
    path: c.path,
    matches: c.matches
      .sort((a, b) => a.tier - b.tier || b.density - a.density)
      .slice(0, opts.perNoteCap)
      .map((m) => m.build()),
    matchedQueries: [...c.matchedQueries],
  }));

  return { notes: selected, truncated, perQueryCounts, perQueryTokenCounts };
}
