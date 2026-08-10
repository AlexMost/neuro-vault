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
  matches: Array<{ tier: number; density: number; match: LexicalMatch }>;
  matchedQueries: Set<string>;
}

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

      const record = (kind: 'title' | 'heading' | 'body', hit: UnitHit, match: LexicalMatch) => {
        const tier = tierOf(kind, hit);
        let cand = byPath.get(notePath);
        if (!cand) {
          cand = {
            path: notePath,
            tier,
            density: hit.density,
            matches: [],
            matchedQueries: new Set(),
          };
          byPath.set(notePath, cand);
        }
        if (tier < cand.tier || (tier === cand.tier && hit.density > cand.density)) {
          cand.tier = tier;
          cand.density = hit.density;
        }
        cand.matchedQueries.add(q.original);
        // avoid duplicate evidence rows across queries for the same location
        const key = `${match.matched_in}:${match.lines?.[0] ?? -1}`;
        if (
          !cand.matches.some((m) => `${m.match.matched_in}:${m.match.lines?.[0] ?? -1}` === key)
        ) {
          cand.matches.push({ tier, density: hit.density, match });
        }
      };

      const titleHit = matchUnit(parsed.title.norm, q.norm, q.tokens);
      if (titleHit) {
        record('title', titleHit, {
          matched_in: 'title',
          snippet: makeSnippet(
            parsed.title.raw,
            parsed.title.map,
            titleHit.firstIndex,
            titleHit.matchLen,
          ),
        });
      }

      for (const unit of parsed.units) {
        const hit = matchUnit(unit.norm, q.norm, q.tokens);
        if (!hit) continue;
        record(unit.kind, hit, {
          matched_in: unit.kind,
          snippet: makeSnippet(unit.raw, unit.map, hit.firstIndex, hit.matchLen),
          lines: unit.lines,
          ...(unit.kind === 'body' && unit.heading !== undefined ? { heading: unit.heading } : {}),
        });
      }
    }
  }

  const candidates = [...byPath.values()].sort(
    (a, b) =>
      compareCandidates(a, b) ||
      opts.getBacklinkCount(b.path) - opts.getBacklinkCount(a.path) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
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
      .map((m) => m.match),
    matchedQueries: [...c.matchedQueries],
  }));

  return { notes: selected, truncated, perQueryCounts, perQueryTokenCounts };
}
