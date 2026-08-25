import { describe, expect, it } from 'vitest';
import type { GoldenEntry } from '../../eval/golden.js';
import { aggregate, scoreQuery } from '../../eval/metrics.js';

const entry = (id: string, lang: 'ua' | 'en', relevant: string[]): GoldenEntry => ({
  id,
  query: id,
  lang,
  relevant,
});

describe('scoreQuery', () => {
  it('relevant ranked third → 1/3 precision, 1/3 RR, hit@3', () => {
    const s = scoreQuery(entry('q1', 'en', ['c.md']), ['a.md', 'b.md', 'c.md', 'd.md']);
    expect(s.first_relevant_rank).toBe(3);
    expect(s.precision_at_3).toBeCloseTo(1 / 3);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 3);
    expect(s.hit_at_3).toBe(true);
  });

  it('no relevant in top-10 → zeros, rank null', () => {
    const s = scoreQuery(entry('q2', 'ua', ['zzz.md']), ['a.md', 'b.md']);
    expect(s.first_relevant_rank).toBeNull();
    expect(s.precision_at_3).toBe(0);
    expect(s.reciprocal_rank).toBe(0);
    expect(s.hit_at_3).toBe(false);
  });

  it('binary set: any relevant path counts; two in top-3 → 2/3 precision', () => {
    const s = scoreQuery(entry('q3', 'en', ['a.md', 'b.md']), ['a.md', 'x.md', 'b.md']);
    expect(s.first_relevant_rank).toBe(1);
    expect(s.precision_at_3).toBeCloseTo(2 / 3);
    expect(s.reciprocal_rank).toBe(1);
  });

  it('relevant ranked fourth → miss for @3 metrics, RR 1/4', () => {
    const s = scoreQuery(entry('q4', 'en', ['d.md']), ['a.md', 'b.md', 'c.md', 'd.md']);
    expect(s.precision_at_3).toBe(0);
    expect(s.hit_at_3).toBe(false);
    expect(s.reciprocal_rank).toBeCloseTo(1 / 4);
  });
});

describe('aggregate', () => {
  it('averages per slice; slices partition by lang', () => {
    const scores = [
      scoreQuery(entry('u1', 'ua', ['a.md']), ['a.md']), // RR 1, hit
      scoreQuery(entry('u2', 'ua', ['b.md']), ['x.md']), // RR 0, miss
      scoreQuery(entry('e1', 'en', ['c.md']), ['x.md', 'c.md']), // RR 1/2, hit
    ];
    const m = aggregate(scores);
    expect(m.overall.n).toBe(3);
    expect(m.ua.n).toBe(2);
    expect(m.en.n).toBe(1);
    expect(m.ua.mrr).toBeCloseTo(0.5);
    expect(m.ua.hit_at_3).toBeCloseTo(0.5);
    expect(m.en.mrr).toBeCloseTo(0.5);
    expect(m.overall.mrr).toBeCloseTo((1 + 0 + 0.5) / 3);
  });

  it('an empty slice reports n 0 and zero metrics', () => {
    const m = aggregate([scoreQuery(entry('u1', 'ua', ['a.md']), ['a.md'])]);
    expect(m.en).toEqual({ n: 0, precision_at_3: 0, mrr: 0, hit_at_3: 0 });
  });
});
