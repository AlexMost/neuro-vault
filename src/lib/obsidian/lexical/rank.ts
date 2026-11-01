import type { ParsedNote } from './blocks.js';
import { countAtBoundary, matchUnit, type UnitHit } from './match.js';
import { normalizeText, tokenizeQuery } from './normalize.js';
import { resolveScorerConfig, type Bm25fParams, type ScorerConfig } from './scorer.js';
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

type UnitKind = 'title' | 'heading' | 'body';

interface MatchRow {
  tier: number;
  density: number;
  key: string;
  // PROTOTYPE (#132): what the bm25f scorer needs to rank evidence rows by
  // their unit's contribution instead of `(tier, density)`.
  kind: UnitKind;
  norm: string;
  phrase: boolean;
  query: string;
  score: number;
  // `build` defers the snippet (an offset-map rebuild + grapheme pass) until
  // the match survives the noteCap / perNoteCap trim.
  build: () => LexicalMatch;
}

interface PerQuery {
  tier: number;
  density: number;
  /** Some unit held this query as a phrase (bm25f phrase bonus). */
  phrase: boolean;
  /** bm25f score of this note for this query variant; 0 under `tiers`. */
  score: number;
}

interface Candidate {
  path: string;
  tier: number; // 0..5 — best across the note's matches
  density: number; // of the best match
  /** bm25f: max over the variants that matched; 0 under `tiers`. */
  score: number;
  matches: MatchRow[];
  matchedQueries: Set<string>;
  // Best match per query variant: each variant ranks the notes on its own.
  byQuery: Map<string, PerQuery>;
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
function tierOf(kind: UnitKind, hit: UnitHit): number {
  const base = kind === 'title' ? 0 : kind === 'heading' ? 2 : 4;
  return base + (hit.phrase ? 0 : 1);
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.tier - b.tier || b.density - a.density || 0 // backlink/path applied by caller-provided comparator below
  );
}

// PROTOTYPE (#132): note length in tokens, the BM25 `len`. A shipped version
// would count this once in `parseNote`; the spike caches it per parsed note.
const noteLengths = new WeakMap<ParsedNote, number>();
const tokensIn = (norm: string): number => (norm.length === 0 ? 0 : norm.split(' ').length);
function noteLength(parsed: ParsedNote): number {
  let len = noteLengths.get(parsed);
  if (len === undefined) {
    len = tokensIn(parsed.title.norm);
    for (const u of parsed.units) len += tokensIn(u.norm);
    noteLengths.set(parsed, len);
  }
  return len;
}

/**
 * PROTOTYPE (#132): BM25F-style score over the ranked set, per query variant.
 *
 *   tf_t   = Σ_f w_f · (word-start occurrences of t in field f)   (weight before saturation)
 *   tf̃_t   = tf_t / (1 − b + b · len / avglen)
 *   idf_t  = ln(1 + (N − df_t + 0.5) / (df_t + 0.5))               (never negative)
 *   score  = Σ_t idf_t · tf̃_t · (k1 + 1) / (tf̃_t + k1)  ×  (1 + p · [phrase in some unit])
 *
 * `N`, `df` and `avglen` are over `notes` (the set after `allowed`), so a filtered
 * call's statistics are the filtered set's. Candidates (notes `matchUnit` accepted)
 * get a score; every other note only contributes to `df` and `avglen`.
 */
function scoreBm25f(
  notes: Map<string, ParsedNote>,
  prepared: Array<{ original: string; tokens: string[] }>,
  byPath: Map<string, Candidate>,
  params: Bm25fParams,
): void {
  const { k1, b, wTitle, wHeading, wBody, phraseBonus } = params;
  const N = notes.size;
  let totalLen = 0;
  for (const parsed of notes.values()) totalLen += noteLength(parsed);
  const avgLen = totalLen > 0 ? totalLen / N : 1;
  const weightOf = (kind: UnitKind): number =>
    kind === 'title' ? wTitle : kind === 'heading' ? wHeading : wBody;

  for (const q of prepared) {
    const tokens = [...new Set(q.tokens)];
    if (tokens.length === 0) continue;
    const df: number[] = tokens.map(() => 0);
    const tf = new Map<string, number[]>();
    for (const [notePath, parsed] of notes) {
      const isCandidate = byPath.get(notePath)?.byQuery.has(q.original) ?? false;
      const row: number[] | undefined = isCandidate ? tokens.map(() => 0) : undefined;
      tokens.forEach((token, i) => {
        let weighted = wTitle * countAtBoundary(parsed.title.norm, token);
        let seen = weighted > 0;
        for (const unit of parsed.units) {
          if (!row && seen) break; // a non-candidate only feeds df
          const count = countAtBoundary(unit.norm, token);
          if (count === 0) continue;
          seen = true;
          weighted += weightOf(unit.kind) * count;
        }
        if (seen) df[i] += 1;
        if (row) row[i] = weighted;
      });
      if (row) tf.set(notePath, row);
    }
    const idf = df.map((d) => Math.log(1 + (N - d + 0.5) / (d + 0.5)));
    for (const [notePath, row] of tf) {
      const cand = byPath.get(notePath)!;
      const perQuery = cand.byQuery.get(q.original)!;
      const lengthNorm = 1 - b + (b * noteLength(notes.get(notePath)!)) / avgLen;
      let score = 0;
      row.forEach((weighted, i) => {
        const tfn = weighted / lengthNorm;
        score += (idf[i] * (tfn * (k1 + 1))) / (tfn + k1);
      });
      score *= 1 + (perQuery.phrase ? phraseBonus : 0);
      perQuery.score = score;
      if (score > cand.score) cand.score = score;
      // Evidence rows: this unit's own contribution, so perNoteCap keeps the strongest.
      for (const m of cand.matches) {
        if (m.query !== q.original) continue;
        let unitScore = 0;
        tokens.forEach((token, i) => {
          unitScore += idf[i] * countAtBoundary(m.norm, token);
        });
        m.score = weightOf(m.kind) * unitScore * (1 + (m.phrase ? phraseBonus : 0));
      }
    }
  }
}

export function rankNotes(opts: {
  notes: Map<string, ParsedNote>;
  queries: string[];
  noteCap: number;
  perNoteCap: number;
  getBacklinkCount: (path: string) => number;
  /** PROTOTYPE (#132): defaults to the environment's choice; `tiers` is the shipped order. */
  scorer?: ScorerConfig;
}): {
  notes: RankedNote[];
  truncated: boolean;
  perQueryCounts: Record<string, number>;
  // Failure-path diagnostic: entries only for queries with zero AND-matches
  // and ≥2 tokens — normalized token → notes where that token alone matches.
  perQueryTokenCounts: Record<string, Record<string, number>>;
} {
  const scorer = opts.scorer ?? resolveScorerConfig();
  // Shape 2 replaces the tier keys with the score; Shape 1 keeps the tier first.
  const scored = scorer.scorer !== 'tiers';
  const bm25f = scorer.scorer === 'bm25f';
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
        kind: UnitKind,
        norm: string,
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
            score: 0,
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
        if (!best) {
          cand.byQuery.set(q.original, {
            tier,
            density: hit.density,
            phrase: hit.phrase,
            score: 0,
          });
        } else {
          if (tier < best.tier || (tier === best.tier && hit.density > best.density)) {
            best.tier = tier;
            best.density = hit.density;
          }
          best.phrase = best.phrase || hit.phrase;
        }
        // avoid duplicate evidence rows across queries for the same location
        const key = `${kind}:${lines?.[0] ?? -1}`;
        if (!cand.matches.some((m) => m.key === key)) {
          cand.matches.push({
            tier,
            density: hit.density,
            key,
            kind,
            norm,
            phrase: hit.phrase,
            query: q.original,
            score: 0,
            build,
          });
        }
      };

      const titleHit = matchUnit(parsed.title.norm, q.norm, q.tokens);
      if (titleHit) {
        record('title', parsed.title.norm, titleHit, undefined, () => ({
          matched_in: 'title',
          snippet: makeSnippet(parsed.title.raw, titleHit.firstIndex, titleHit.matchLen),
        }));
      }

      for (const unit of parsed.units) {
        const hit = matchUnit(unit.norm, q.norm, q.tokens);
        if (!hit) continue;
        record(unit.kind, unit.norm, hit, unit.lines, () => ({
          matched_in: unit.kind,
          snippet: makeSnippet(unit.raw, hit.firstIndex, hit.matchLen),
          lines: unit.lines,
          ...(unit.kind === 'body' && unit.heading !== undefined ? { heading: unit.heading } : {}),
        }));
      }
    }
  }

  if (scored) scoreBm25f(opts.notes, prepared, byPath, scorer.bm25f);

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
        if (bm25f) return qb.score - qa.score || tieBreak(a, b);
        if (scored) return qa.tier - qb.tier || qb.score - qa.score || tieBreak(a, b);
        return qa.tier - qb.tier || qb.density - qa.density || tieBreak(a, b);
      });
    ranked.forEach((c, rank) => {
      fused.set(c, (fused.get(c) ?? 0) + weight / (VARIANT_FUSION_K + rank + 1));
    });
  });

  const candidates = [...byPath.values()].sort(
    (a, b) =>
      (fused.get(b) ?? 0) - (fused.get(a) ?? 0) ||
      (bm25f
        ? b.score - a.score
        : scored
          ? a.tier - b.tier || b.score - a.score
          : compareCandidates(a, b)) ||
      tieBreak(a, b),
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
  const rowOrder = (a: MatchRow, b: MatchRow) =>
    (bm25f ? b.score - a.score : 0) ||
    a.tier - b.tier ||
    (scored ? b.score - a.score : 0) ||
    b.density - a.density;
  const selected = candidates.slice(0, opts.noteCap).map((c) => ({
    path: c.path,
    matches: c.matches
      .sort(rowOrder)
      .slice(0, opts.perNoteCap)
      .map((m) => m.build()),
    matchedQueries: [...c.matchedQueries],
  }));

  return { notes: selected, truncated, perQueryCounts, perQueryTokenCounts };
}
