import type { GoldenEntry } from './golden.js';
import type { RankedPath } from './pipelines.js';

export interface QueryScore {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  top: string[];
  /** The score each `top` path was ranked by: cosine for `semantic`, the fused RRF score for `fused`. */
  top_scores: number[];
  /** 1-based ranks of every relevant path inside `top`. */
  relevant_ranks: number[];
  /** Best cosine between the query and any relevant note, ranked or not; null when none has a note vector. */
  best_relevant_similarity: number | null;
  /** 1-based rank of the first relevant hit within the top list, or null. */
  first_relevant_rank: number | null;
  precision_at_3: number;
  reciprocal_rank: number;
  hit_at_3: boolean;
}

export function scoreQuery(
  entry: GoldenEntry,
  ranked: RankedPath[],
  bestRelevantSimilarity: number | null,
): QueryScore {
  const relevant = new Set(entry.relevant);
  const top = ranked.map((r) => r.path);
  const relevant_ranks = top.flatMap((p, i) => (relevant.has(p) ? [i + 1] : []));
  const first_relevant_rank = relevant_ranks[0] ?? null;
  const hitsAt3 = relevant_ranks.filter((r) => r <= 3).length;
  return {
    id: entry.id,
    query: entry.query,
    lang: entry.lang,
    top,
    top_scores: ranked.map((r) => r.score),
    relevant_ranks,
    best_relevant_similarity: bestRelevantSimilarity,
    first_relevant_rank,
    precision_at_3: hitsAt3 / 3,
    reciprocal_rank: first_relevant_rank === null ? 0 : 1 / first_relevant_rank,
    hit_at_3: hitsAt3 > 0,
  };
}

export interface SliceMetrics {
  n: number;
  precision_at_3: number;
  mrr: number;
  hit_at_3: number;
}

export interface Metrics {
  overall: SliceMetrics;
  ua: SliceMetrics;
  en: SliceMetrics;
}

function slice(scores: QueryScore[]): SliceMetrics {
  if (scores.length === 0) return { n: 0, precision_at_3: 0, mrr: 0, hit_at_3: 0 };
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  return {
    n: scores.length,
    precision_at_3: mean(scores.map((s) => s.precision_at_3)),
    mrr: mean(scores.map((s) => s.reciprocal_rank)),
    hit_at_3: mean(scores.map((s) => (s.hit_at_3 ? 1 : 0))),
  };
}

export function aggregate(scores: QueryScore[]): Metrics {
  return {
    overall: slice(scores),
    ua: slice(scores.filter((s) => s.lang === 'ua')),
    en: slice(scores.filter((s) => s.lang === 'en')),
  };
}
