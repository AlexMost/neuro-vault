import { describe, expect, it } from 'vitest';

import type { QueryScore } from '../../eval/metrics.js';
import {
  collectPopulations,
  computeCalibrationStats,
  computeGuards,
  DEFAULT_KEYS,
  passRate,
  quantiles,
  thresholdForPassRate,
} from '../../eval/stats.js';
import { TEST_SIMILARITY } from '../_identity.js';

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
  it('names every similarity default exactly once', () => {
    expect([...DEFAULT_KEYS].sort()).toEqual(Object.keys(TEST_SIMILARITY).sort());
  });
});

function score(over: Partial<QueryScore>): QueryScore {
  return {
    id: 'q',
    query: 'q',
    lang: 'ua',
    top: [],
    top_scores: [],
    relevant_ranks: [],
    best_relevant_similarity: null,
    first_relevant_rank: null,
    precision_at_3: 0,
    reciprocal_rank: 0,
    hit_at_3: false,
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

describe('collectPopulations + computeCalibrationStats', () => {
  const sources = new Map([
    ['a.md', { path: 'a.md', embedding: [1, 0], blocks: [] }],
    ['b.md', { path: 'b.md', embedding: [0.8, 0.6], blocks: [] }],
    ['c.md', { path: 'c.md', embedding: [0, 1], blocks: [] }],
  ]);
  const shape = { seedPool: 1, expansionLimit: 1, topK: 3 };

  it('collects the four populations', () => {
    const p = collectPopulations({ queryVectors: [[1, 0]], sources, ...shape });
    expect(p.query_candidates).toHaveLength(3);
    expect(p.expansion_neighbours).toEqual([expect.closeTo(0.8)]);
    expect(p.note_max).toHaveLength(3);
    expect(p.note_top10).toHaveLength(6);
  });

  it('reports, per default, the threshold and pass rate over its own population', () => {
    const populations = collectPopulations({ queryVectors: [[1, 0]], sources, ...shape });
    const stats = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      deepPool: 8,
    });
    expect(stats.pass_rates.deep).toEqual({
      population: 'query_candidates',
      threshold: TEST_SIMILARITY.deep,
      pass_rate: passRate(populations.query_candidates, TEST_SIMILARITY.deep),
    });
    expect(stats.pass_rates.expansionFloor).toMatchObject({
      population: 'expansion_neighbours',
      pass_rate: 1, // the one neighbour, 0.8, clears 0.35
    });
    expect(stats.populations.note_max.n).toBe(3);
    expect(stats.suggested).toBeUndefined();
  });

  it('suggests, per default, the threshold reproducing a baseline pass rate', () => {
    const populations = collectPopulations({ queryVectors: [[1, 0]], sources, ...shape });
    const baseline = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      deepPool: 8,
    });
    // A "new model" whose similarities sit lower: every vector pair is rotated apart.
    const shifted = collectPopulations({
      queryVectors: [[0.6, 0.8]],
      sources: new Map([
        ['a.md', { path: 'a.md', embedding: [1, 0], blocks: [] }],
        ['b.md', { path: 'b.md', embedding: [0.6, 0.8], blocks: [] }],
        ['c.md', { path: 'c.md', embedding: [0, 1], blocks: [] }],
      ]),
      ...shape,
    });
    const again = computeCalibrationStats({
      populations: shifted,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      deepPool: 8,
      baseline,
    });
    const suggested = again.suggested;
    expect(suggested?.deep.baseline_pass_rate).toBe(baseline.pass_rates.deep.pass_rate);
    expect(suggested?.deep.threshold).toBeCloseTo(
      thresholdForPassRate(shifted.query_candidates, baseline.pass_rates.deep.pass_rate)!,
    );
    // The suggested threshold reproduces the baseline's pass rate on the new population.
    expect(passRate(shifted.query_candidates, suggested?.deep.threshold ?? NaN)).toBeCloseTo(
      baseline.pass_rates.deep.pass_rate,
    );
  });

  it('suggests nothing, rather than failing, for a default whose population is empty', () => {
    const populations = collectPopulations({ queryVectors: [[1, 0]], sources, ...shape });
    const baseline = computeCalibrationStats({
      populations,
      similarity: TEST_SIMILARITY,
      perQuery: [],
      deepPool: 8,
    });
    const again = computeCalibrationStats({
      populations: { ...populations, expansion_neighbours: [] },
      similarity: TEST_SIMILARITY,
      perQuery: [],
      deepPool: 8,
      baseline,
    });
    expect(again.suggested?.expansionFloor.threshold).toBeNull();
    expect(again.suggested?.deep.threshold).not.toBeNull();
  });
});
