import { describe, expect, it } from 'vitest';

import type { QueryScore } from '../../eval/metrics.js';
import {
  collectPopulations,
  computeCalibrationStats,
  computeSeparation,
  computeGuards,
  DEFAULT_KEYS,
  measuredKeys,
  passRate,
  POPULATION_OF,
  quantiles,
  thresholdForPassRate,
} from '../../eval/stats.js';
import type { SmartSource } from '../../src/lib/obsidian/corpus/types.js';
import { TEST_SIMILARITY } from '../_identity.js';
import { corpusOver } from '../_memory-corpus.js';

describe('quantiles', () => {
  it('summarises a population by nearest lower rank', () => {
    const q = quantiles([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1]);
    expect(q).toMatchObject({ n: 11, min: 0.1, p50: 0.6, max: 1.1 });
  });
});

describe('passRate / thresholdForPassRate', () => {
  const values = [0.2, 0.4, 0.6, 0.8, 1.0];

  it('passRate counts values at or above the threshold', () => {
    expect(passRate(values, 0.6)).toBe(0.6);
  });

  it('thresholdForPassRate inverts passRate', () => {
    expect(thresholdForPassRate(values, 0.6)).toBe(0.6);
    expect(passRate(values, thresholdForPassRate(values, 0.6)!)).toBe(0.6);
    expect(thresholdForPassRate(values, 1)).toBe(0.2);
  });

  it('a zero pass rate yields a threshold above every value', () => {
    expect(thresholdForPassRate(values, 0)).toBeGreaterThan(1.0);
  });

  it('treats a run of tied values as one step, picking the closest achievable pass rate', () => {
    // A threshold of 0.9 passes all three 0.9s (rate 0.75), not one; passing
    // none (rate 0) is the closer match to 0.25.
    const tied = [0.9, 0.5, 0.9, 0.9];
    const t = thresholdForPassRate(tied, 0.25)!;
    expect(t).toBeGreaterThan(0.9);
    expect(passRate(tied, t)).toBe(0);
  });

  it('on an exact tie between two pass counts, picks the more permissive', () => {
    // Mutual-nearest pairs: every similarity appears twice. Rate 0.5 → 3 of 6,
    // which sits exactly between 2 (0.95) and 4 (0.9).
    const pairs = [0.95, 0.95, 0.9, 0.9, 0.8, 0.8];
    expect(thresholdForPassRate(pairs, 0.5)).toBe(0.9);
  });

  it('has no threshold for an empty population', () => {
    expect(thresholdForPassRate([], 0.5)).toBeNull();
  });
});

describe('DEFAULT_KEYS', () => {
  it('names every similarity default except the unmeasured block floor exactly once', () => {
    expect([...DEFAULT_KEYS].sort()).toEqual(
      Object.keys(TEST_SIMILARITY)
        .filter((key) => key !== 'blockFloor')
        .sort(),
    );
  });

  it('measures only the defaults a profile defines', () => {
    const { fallback: _fallback, ...withoutFallback } = TEST_SIMILARITY;
    expect(measuredKeys(TEST_SIMILARITY)).toEqual(DEFAULT_KEYS);
    expect(measuredKeys(withoutFallback)).toEqual(DEFAULT_KEYS.filter((key) => key !== 'fallback'));
  });

  it('is exactly the set of defaults POPULATION_OF assigns a population to', () => {
    expect(Object.keys(POPULATION_OF).sort()).toEqual([...DEFAULT_KEYS].sort());
  });
});

function score(over: Partial<QueryScore>): QueryScore {
  return {
    id: 'q',
    query: 'q',
    class: 'concept',
    lang: 'ua',
    top: [],
    top_scores: [],
    result_count: 0,
    relevant_ranks: [],
    best_relevant_similarity: null,
    first_relevant_rank: null,
    reciprocal_rank: 0,
    hit_at_3: false,
    recall_at_10: 0,
    ...over,
  };
}

describe('computeGuards', () => {
  it('counts first-relevant hits inside the deep pool that the deep default would drop', () => {
    const perQuery = [
      score({ first_relevant_rank: 2, relevant_ranks: [2], top_scores: [0.5, 0.3] }), // 0.3 < deep 0.35 → dropped
      score({ first_relevant_rank: 1, relevant_ranks: [1], top_scores: [0.9] }),
      score({ first_relevant_rank: 9, relevant_ranks: [9], top_scores: Array(9).fill(0.1) }), // outside pool 8
    ];
    expect(computeGuards(perQuery, TEST_SIMILARITY, 8).deep_filtered_first_relevant).toBe(1);
  });

  it('measures the hit@3 drop the quick default causes', () => {
    const perQuery = [
      score({ relevant_ranks: [1], top_scores: [0.45] }), // hit at 0, lost at quick 0.5
      score({ relevant_ranks: [2], top_scores: [0.9, 0.8] }), // kept
    ];
    expect(computeGuards(perQuery, TEST_SIMILARITY, 8).quick_hit_at_3_drop).toBe(1);
  });
});

describe('computeSeparation', () => {
  it('summarises top-1 similarity on answerable and control entries apart', () => {
    const separation = computeSeparation([
      { control: false, similarity: 0.8 },
      { control: false, similarity: 0.6 },
      { control: true, similarity: 0.3 },
    ]);
    expect(separation.answerable).toMatchObject({ n: 2, min: 0.6, max: 0.8 });
    expect(separation.control).toMatchObject({ n: 1, min: 0.3, max: 0.3 });
  });

  it('reports an empty side as n 0 rather than failing', () => {
    expect(computeSeparation([{ control: false, similarity: 0.5 }]).control.n).toBe(0);
  });
});

describe('collectPopulations + computeCalibrationStats', () => {
  const sources = new Map([
    ['a.md', { path: 'a.md', embedding: new Float32Array([1, 0]), blocks: [] }],
    ['b.md', { path: 'b.md', embedding: new Float32Array([0.8, 0.6]), blocks: [] }],
    ['c.md', { path: 'c.md', embedding: new Float32Array([0, 1]), blocks: [] }],
  ]);
  // topK 2 < the three notes, so the ranked and unranked populations differ.
  const shape = { seedPool: 1, expansionLimit: 1, topK: 2 };
  /** The populations of `queryVectors` over `notes`, read through the corpus reads. */
  const populationsOf = (queryVectors: number[][], notes: Map<string, SmartSource> = sources) =>
    collectPopulations({
      queryVectors,
      corpus: corpusOver(notes),
      paths: [...notes.keys()],
      ...shape,
    });

  it('collects the ranked and the unranked populations', async () => {
    const p = await populationsOf([[1, 0]]);
    expect(p.query_candidates).toHaveLength(2);
    expect(p.query_all).toHaveLength(3);
    expect(p.expansion_neighbours).toEqual([expect.closeTo(0.8)]);
    // Seed a.md against b and c, never against itself.
    expect([...p.seed_all].sort()).toEqual([expect.closeTo(0), expect.closeTo(0.8)]);
    expect(p.note_max).toHaveLength(3);
    expect(p.note_top10).toHaveLength(6);
    expect(p.note_all).toHaveLength(6); // 3 sources × 2 others, ordered pairs
  });

  it('reports a quantile summary for every population', async () => {
    const populations = await populationsOf([[1, 0]]);
    const stats = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
    });
    expect(Object.keys(stats.populations).sort()).toEqual(Object.keys(populations).sort());
    expect(stats.populations.query_all.n).toBe(3);
    expect(stats.populations.note_all.n).toBe(6);
  });

  it('reports, per default, the threshold and pass rate over its own population', async () => {
    const populations = await populationsOf([[1, 0]]);
    const stats = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
    });
    expect(stats.pass_rates.deep).toEqual({
      population: 'query_all',
      threshold: TEST_SIMILARITY.deep,
      pass_rate: passRate(populations.query_all, TEST_SIMILARITY.deep),
    });
    expect(stats.pass_rates.expansionFloor).toMatchObject({
      population: 'seed_all',
      pass_rate: 0.5, // of the seed's two neighbours (0.8 and 0), only 0.8 clears 0.35
    });
    expect(stats.pass_rates.similarNotes.population).toBe('note_all');
    expect(stats.pass_rates.duplicates.population).toBe('note_max');
    expect(stats.populations.note_max.n).toBe(3);
    expect(stats.suggested).toBeUndefined();
  });

  it('suggests, per default, the threshold reproducing a baseline pass rate', async () => {
    const populations = await populationsOf([[1, 0]]);
    const baseline = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
    });
    // A "new model" whose similarities sit lower: every vector pair is rotated apart.
    const shifted = await populationsOf(
      [[0.6, 0.8]],
      new Map([
        ['a.md', { path: 'a.md', embedding: new Float32Array([1, 0]), blocks: [] }],
        ['b.md', { path: 'b.md', embedding: new Float32Array([0.6, 0.8]), blocks: [] }],
        ['c.md', { path: 'c.md', embedding: new Float32Array([0, 1]), blocks: [] }],
      ]),
    );
    const again = computeCalibrationStats({
      populations: shifted,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
      baseline,
    });
    const suggested = again.suggested;
    expect(suggested?.deep.baseline_pass_rate).toBe(baseline.pass_rates.deep.pass_rate);
    expect(suggested?.deep.threshold).toBeCloseTo(
      thresholdForPassRate(shifted.query_all, baseline.pass_rates.deep.pass_rate)!,
    );
    // The suggested threshold reproduces the baseline's pass rate on the new population.
    expect(passRate(shifted.query_all, suggested?.deep.threshold ?? NaN)).toBeCloseTo(
      baseline.pass_rates.deep.pass_rate,
    );
  });

  it('measures no fallback for a profile without one', async () => {
    const populations = await populationsOf([[1, 0]]);
    const { fallback: _fallback, ...withoutFallback } = TEST_SIMILARITY;
    const baseline = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
    });
    const stats = computeCalibrationStats({
      populations,
      similarity: withoutFallback,
      perQuery: [],
      top1: [],
      deepPool: 8,
      baseline,
    });
    expect(stats.pass_rates).not.toHaveProperty('fallback');
    expect(stats.pass_rates.deep.population).toBe('query_all');
    expect(stats.suggested).not.toHaveProperty('fallback');
    expect(stats.suggested?.deep.baseline_pass_rate).toBe(baseline.pass_rates.deep.pass_rate);
  });

  it('suggests nothing, rather than failing, for a default whose population is empty', async () => {
    const populations = await populationsOf([[1, 0]]);
    const baseline = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
    });
    const again = computeCalibrationStats({
      populations: { ...populations, seed_all: [] },
      similarity: TEST_SIMILARITY,
      perQuery: [],
      top1: [],
      deepPool: 8,
      baseline,
    });
    expect(again.suggested?.expansionFloor.threshold).toBeNull();
    expect(again.suggested?.deep.threshold).not.toBeNull();
  });
});
