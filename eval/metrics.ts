import type { GoldenEntry } from './golden.js';

export interface QueryScore {
  id: string;
  query: string;
  lang: 'ua' | 'en';
  top: string[];
  /** 1-based rank of the first relevant hit within the top list, or null. */
  first_relevant_rank: number | null;
  precision_at_3: number;
  reciprocal_rank: number;
  hit_at_3: boolean;
}

export function scoreQuery(entry: GoldenEntry, top: string[]): QueryScore {
  const relevant = new Set(entry.relevant);
  const firstIndex = top.findIndex((p) => relevant.has(p));
  const first_relevant_rank = firstIndex === -1 ? null : firstIndex + 1;
  const hitsAt3 = top.slice(0, 3).filter((p) => relevant.has(p)).length;
  return {
    id: entry.id,
    query: entry.query,
    lang: entry.lang,
    top,
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
