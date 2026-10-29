import type { ICorpusReader } from '../src/lib/obsidian/corpus/corpus.js';
import type { SimilarityDefaults } from '../src/lib/model-profiles.js';
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
  /**
   * Each golden query vector against every source — unranked. The ranked
   * `query_candidates` pass 100 % at five of six defaults on bge-micro, which
   * pins no threshold (design D11).
   */
  query_all: number[];
  /**
   * Each seed against every source that is not one of that query's seeds —
   * unranked, so the expansion floor is matched on more than the top few
   * neighbours (design D11).
   */
  seed_all: number[];
  /**
   * Each source against every other source (ordered pairs) — unranked, where
   * `note_top10` keeps only each note's ten nearest (design D11).
   */
  note_all: number[];
}

export interface Guards {
  /** First-relevant hits inside the deep pool that the deep default would filter out. Target: 0. */
  deep_filtered_first_relevant: number;
  /** Queries that lose their hit@3 when the quick default filters the ranking. Target: ≤ 1. */
  quick_hit_at_3_drop: number;
}

export type DefaultKey = keyof SimilarityDefaults;

/**
 * Top-1 similarity on control vs answerable entries: how far apart the best match for a
 * query the vault cannot answer sits from the best match for one it can. Input for the
 * query-side thresholds — a floor between the two distributions drops control noise
 * without dropping answers.
 */
export interface Separation {
  answerable: Quantiles;
  control: Quantiles;
}

/** One golden entry's top-1: the best cosine any of its query strings reaches on any note. */
export interface EntryTop1 {
  control: boolean;
  similarity: number;
}

export interface CalibrationStats {
  populations: Record<keyof Populations, Quantiles>;
  pass_rates: Record<
    DefaultKey,
    { population: keyof Populations; threshold: number; pass_rate: number }
  >;
  guards: Guards;
  separation: Separation;
  /** `threshold` is null when this run's population is empty — there is nothing to match. */
  suggested?: Record<DefaultKey, { baseline_pass_rate: number; threshold: number | null }>;
  /** The report `suggested` was derived from; present exactly when `suggested` is. */
  baseline?: {
    file: string;
    model_key: string;
    vault_sha: string | null;
    code_sha: string | null;
  };
}

/**
 * Which population each default is calibrated on (design D11): unranked
 * wherever a ranked one exists, because the ranked ones pass 100 % at five of
 * six defaults on bge-micro and so cannot tell two thresholds apart.
 */
export const POPULATION_OF: Record<DefaultKey, keyof Populations> = {
  quick: 'query_all',
  deep: 'query_all',
  fallback: 'query_all',
  expansionFloor: 'seed_all',
  similarNotes: 'note_all',
  duplicates: 'note_max',
};

/** Every default `--stats` reports on — derived, so a new `SimilarityDefaults` key cannot be missed. */
export const DEFAULT_KEYS = Object.keys(POPULATION_OF) as DefaultKey[];

export function quantiles(values: number[]): Quantiles {
  // A typed copy sorts numerically without a comparator, at 8 bytes a value —
  // `note_all` holds N·(N−1) of them.
  const sorted = Float64Array.from(values).sort();
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
  let passing = 0;
  for (const v of values) if (v >= threshold) passing += 1;
  return passing / values.length;
}

/**
 * The threshold at which `rate` of `values` pass — the inverse of
 * {@link passRate}, or null for an empty population. A threshold passes every
 * value at or above it, so a run of tied values passes or fails as a whole
 * (note populations always hold ties: a mutual-nearest pair contributes its
 * similarity twice). The candidates are therefore "above every value" and each
 * distinct value; the one whose pass count is closest to `rate` wins, the
 * more permissive on an exact tie (as `Math.round` would).
 */
export function thresholdForPassRate(values: number[], rate: number): number | null {
  const ascending = Float64Array.from(values).sort();
  const n = ascending.length;
  if (n === 0) return null;
  const target = rate * n;
  let best = { threshold: ascending[n - 1] + 1e-6, passing: 0 };
  // Walks from the highest value down, so a tie on distance goes to the more permissive.
  for (let i = n - 1; i >= 0; i -= 1) {
    if (ascending[i - 1] === ascending[i]) continue; // not yet the end of a tied run
    const passing = n - i;
    if (Math.abs(passing - target) <= Math.abs(best.passing - target)) {
      best = { threshold: ascending[i], passing };
    }
  }
  return best.threshold;
}

/**
 * The most note vectors `--stats` takes: `note_all` holds N·(N−1)
 * similarities in one array, and V8 caps an array at 2^27 elements.
 */
export const MAX_STATS_SOURCES = 11_000;

export async function collectPopulations(args: {
  queryVectors: number[][];
  corpus: ICorpusReader;
  /** Every note the corpus holds a vector for. */
  paths: readonly string[];
  seedPool: number;
  expansionLimit: number;
  topK: number;
}): Promise<Populations> {
  const { corpus } = args;
  /** Every note's similarity to `anchor`, best first; null for a note without a vector. */
  const rankAll = async (
    anchor: { vector: number[] } | { path: string },
    exclude?: string,
  ): Promise<{ path: string; similarity: number }[] | null> => {
    const [hits] = await corpus.nearest([anchor], {
      threshold: -1,
      ...(exclude === undefined ? {} : { exclude: [exclude] }),
    });
    return hits;
  };
  const query_candidates: number[] = [];
  const query_all: number[] = [];
  const expansion_neighbours: number[] = [];
  const seed_all: number[] = [];
  // Each vector is ranked once over every note; the ranked populations are slices of it.
  for (const queryVector of args.queryVectors) {
    const all = (await rankAll({ vector: queryVector })) ?? [];
    query_all.push(...all.map((r) => r.similarity));
    const ranked = all.slice(0, args.topK);
    query_candidates.push(...ranked.map((r) => r.similarity));
    const seeds = ranked.slice(0, args.seedPool);
    const seedSet = new Set(seeds.map((s) => s.path));
    for (const seed of seeds) {
      const neighbours = await rankAll({ path: seed.path });
      if (!neighbours) continue;
      const others = neighbours.filter((n) => !seedSet.has(n.path));
      seed_all.push(...others.map((n) => n.similarity));
      // Mirrors the production expansion leg, minus its floor.
      expansion_neighbours.push(...others.slice(0, args.expansionLimit).map((n) => n.similarity));
    }
  }
  const note_all: number[] = [];
  const note_top10: number[] = [];
  const note_max: number[] = [];
  for (const notePath of args.paths) {
    const others = (await rankAll({ path: notePath }, notePath)) ?? [];
    note_all.push(...others.map((n) => n.similarity));
    note_top10.push(...others.slice(0, 10).map((n) => n.similarity));
    const [nearest] = others;
    if (nearest) note_max.push(nearest.similarity);
  }
  return {
    query_candidates,
    expansion_neighbours,
    note_top10,
    note_max,
    query_all,
    seed_all,
    note_all,
  };
}

/**
 * Preconditions: `top_scores` must be cosine similarities (a `semantic` run —
 * fused RRF scores mean nothing against a similarity threshold), and the filter
 * is modelled as a plain threshold, NOT production's one-shot retry at
 * `fallback`. A query whose best hit sits between `fallback` and the threshold
 * therefore counts as lost though production would recover it: conservative,
 * never an under-report.
 */
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

export function computeSeparation(top1: EntryTop1[]): Separation {
  return {
    answerable: quantiles(top1.filter((t) => !t.control).map((t) => t.similarity)),
    control: quantiles(top1.filter((t) => t.control).map((t) => t.similarity)),
  };
}

export function computeCalibrationStats(args: {
  populations: Populations;
  similarity: SimilarityDefaults;
  perQuery: QueryScore[];
  top1: EntryTop1[];
  deepPool: number;
  baseline?: CalibrationStats;
}): CalibrationStats {
  const pass_rates = Object.fromEntries(
    DEFAULT_KEYS.map((key) => {
      const population = POPULATION_OF[key];
      const threshold = args.similarity[key];
      return [
        key,
        { population, threshold, pass_rate: passRate(args.populations[population], threshold) },
      ];
    }),
  ) as CalibrationStats['pass_rates'];
  const stats: CalibrationStats = {
    // Iterates the `Populations` keys, so a new population cannot go unsummarised.
    populations: Object.fromEntries(
      (Object.keys(args.populations) as (keyof Populations)[]).map((key) => [
        key,
        quantiles(args.populations[key]),
      ]),
    ) as CalibrationStats['populations'],
    pass_rates,
    guards: computeGuards(args.perQuery, args.similarity, args.deepPool),
    separation: computeSeparation(args.top1),
  };
  const { baseline } = args;
  if (baseline) {
    stats.suggested = Object.fromEntries(
      DEFAULT_KEYS.map((key) => {
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
