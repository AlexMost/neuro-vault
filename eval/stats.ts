import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';
import type { SimilarityDefaults } from '../src/modules/semantic/model-profiles.js';
import { findNeighbors } from '../src/modules/semantic/search-engine.js';
import type { QueryScore } from './metrics.js';

export interface Quantiles {
  n: number;
  min: number;
  p05: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  max: number;
}

export interface Populations {
  /** Query↔note similarities of each golden query's top-k candidates. */
  query_candidates: number[];
  /** Seed↔neighbour similarities the expansion leg sees (unfloored). */
  expansion_neighbours: number[];
  /** Every note's top-10 neighbour similarities. */
  note_top10: number[];
  /** Every note's maximum similarity to any other note. */
  note_max: number[];
}

export interface Guards {
  /** First-relevant hits inside the deep pool that the deep default would filter out. Target: 0. */
  deep_filtered_first_relevant: number;
  /** Queries that lose their hit@3 when the quick default filters the ranking. Target: ≤ 1. */
  quick_hit_at_3_drop: number;
}

type DefaultKey = keyof SimilarityDefaults;

export interface CalibrationStats {
  populations: Record<keyof Populations, Quantiles>;
  pass_rates: Record<
    DefaultKey,
    { population: keyof Populations; threshold: number; pass_rate: number }
  >;
  guards: Guards;
  suggested?: Record<DefaultKey, { baseline_pass_rate: number; threshold: number }>;
}

/** Which population each default filters (design D11). */
const POPULATION_OF: Record<DefaultKey, keyof Populations> = {
  quick: 'query_candidates',
  deep: 'query_candidates',
  fallback: 'query_candidates',
  expansionFloor: 'expansion_neighbours',
  similarNotes: 'note_top10',
  duplicates: 'note_max',
};

export function quantiles(values: number[]): Quantiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor(q * (sorted.length - 1))] ?? 0;
  return {
    n: sorted.length,
    min: at(0),
    p05: at(0.05),
    p10: at(0.1),
    p25: at(0.25),
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    max: at(1),
  };
}

export function passRate(values: number[], threshold: number): number {
  if (values.length === 0) return 0;
  return values.filter((v) => v >= threshold).length / values.length;
}

/** The threshold at which `rate` of `values` pass — the inverse of {@link passRate}. */
export function thresholdForPassRate(values: number[], rate: number): number {
  const descending = [...values].sort((a, b) => b - a);
  const [highest] = descending;
  if (highest === undefined) throw new Error('cannot calibrate against an empty population');
  const count = Math.round(rate * descending.length);
  if (count <= 0) return highest + 1e-6;
  return descending[Math.min(count, descending.length) - 1] ?? highest;
}

export function collectPopulations(args: {
  queryVectors: number[][];
  sources: Map<string, SmartSource>;
  seedPool: number;
  expansionLimit: number;
  topK: number;
}): Populations {
  const { sources } = args;
  const query_candidates: number[] = [];
  const expansion_neighbours: number[] = [];
  for (const queryVector of args.queryVectors) {
    const ranked = findNeighbors({
      queryVector,
      sources: sources.values(),
      threshold: -1,
      limit: args.topK,
    });
    query_candidates.push(...ranked.map((r) => r.similarity));
    const seeds = ranked.slice(0, args.seedPool);
    const seedSet = new Set(seeds.map((s) => s.path));
    for (const seed of seeds) {
      const source = sources.get(seed.path);
      if (!source) continue;
      // Mirrors the production expansion leg, minus its floor.
      const neighbours = findNeighbors({
        queryVector: source.embedding,
        sources: sources.values(),
        threshold: -1,
        limit: args.expansionLimit + seedSet.size,
      })
        .filter((n) => !seedSet.has(n.path))
        .slice(0, args.expansionLimit);
      expansion_neighbours.push(...neighbours.map((n) => n.similarity));
    }
  }
  const note_top10: number[] = [];
  const note_max: number[] = [];
  for (const source of sources.values()) {
    const neighbours = findNeighbors({
      queryVector: source.embedding,
      sources: sources.values(),
      threshold: -1,
      limit: 10,
      excludePath: source.path,
    });
    note_top10.push(...neighbours.map((n) => n.similarity));
    const [nearest] = neighbours;
    if (nearest) note_max.push(nearest.similarity);
  }
  return { query_candidates, expansion_neighbours, note_top10, note_max };
}

export function computeGuards(
  perQuery: QueryScore[],
  similarity: SimilarityDefaults,
  deepPool: number,
): Guards {
  // A rank always indexes a score the run itself recorded; a missing one is
  // treated as "not filtered" rather than guessed at.
  const scoreAt = (q: QueryScore, rank: number): number => q.top_scores[rank - 1] ?? Infinity;
  let deepFiltered = 0;
  let hitsAtZero = 0;
  let hitsAtQuick = 0;
  for (const q of perQuery) {
    const first = q.first_relevant_rank;
    if (first !== null && first <= deepPool && scoreAt(q, first) < similarity.deep) {
      deepFiltered += 1;
    }
    const top3 = q.relevant_ranks.filter((r) => r <= 3);
    if (top3.length > 0) hitsAtZero += 1;
    if (top3.some((r) => scoreAt(q, r) >= similarity.quick)) hitsAtQuick += 1;
  }
  return {
    deep_filtered_first_relevant: deepFiltered,
    quick_hit_at_3_drop: hitsAtZero - hitsAtQuick,
  };
}

export function computeCalibrationStats(args: {
  populations: Populations;
  similarity: SimilarityDefaults;
  perQuery: QueryScore[];
  deepPool: number;
  baseline?: CalibrationStats;
}): CalibrationStats {
  const keys = Object.keys(POPULATION_OF) as DefaultKey[];
  const pass_rates = Object.fromEntries(
    keys.map((key) => {
      const population = POPULATION_OF[key];
      const threshold = args.similarity[key];
      return [
        key,
        { population, threshold, pass_rate: passRate(args.populations[population], threshold) },
      ];
    }),
  ) as CalibrationStats['pass_rates'];
  const stats: CalibrationStats = {
    populations: {
      query_candidates: quantiles(args.populations.query_candidates),
      expansion_neighbours: quantiles(args.populations.expansion_neighbours),
      note_top10: quantiles(args.populations.note_top10),
      note_max: quantiles(args.populations.note_max),
    },
    pass_rates,
    guards: computeGuards(args.perQuery, args.similarity, args.deepPool),
  };
  const { baseline } = args;
  if (baseline) {
    stats.suggested = Object.fromEntries(
      keys.map((key) => {
        const rate = baseline.pass_rates[key].pass_rate;
        return [
          key,
          {
            baseline_pass_rate: rate,
            threshold: thresholdForPassRate(args.populations[POPULATION_OF[key]], rate),
          },
        ];
      }),
    ) as CalibrationStats['suggested'];
  }
  return stats;
}
