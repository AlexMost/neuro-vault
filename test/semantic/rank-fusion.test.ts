import { describe, expect, it } from 'vitest';
import { adaptiveK, flattenExpansion, fuseRanks } from '../../src/modules/semantic/rank-fusion.js';

describe('adaptiveK', () => {
  it('clamps sqrt(N) into [5, 60]', () => {
    expect(adaptiveK(25)).toBe(5); // sqrt=5 → floor of range
    expect(adaptiveK(4)).toBe(5); // below range → 5
    expect(adaptiveK(400)).toBe(20); // sqrt=20
    expect(adaptiveK(2500)).toBe(50); // sqrt=50
    expect(adaptiveK(10000)).toBe(60); // above range → 60
  });
});

describe('flattenExpansion', () => {
  const seed = (path: string, related: Array<[string, number]>) => ({
    path,
    similarity: 0.9,
    // Always populated post-fold; flattenExpansion ignores it.
    matched_queries: ['q'],
    blocks: [],
    related: related.map(([p, s]) => ({ path: p, expansion_similarity: s })),
  });
  it('dedupes repeated paths keeping max similarity, ordered desc', () => {
    const out = flattenExpansion([
      seed('a.md', [
        ['x.md', 0.82],
        ['y.md', 0.7],
      ]),
      seed('b.md', [['x.md', 0.89]]),
    ]);
    expect(out).toEqual([
      { path: 'x.md', expansion_similarity: 0.89 },
      { path: 'y.md', expansion_similarity: 0.7 },
    ]);
  });
  it('excludes semantic seed paths', () => {
    const out = flattenExpansion([
      seed('a.md', [
        ['b.md', 0.95],
        ['z.md', 0.5],
      ]),
      seed('b.md', []),
    ]);
    expect(out.map((e) => e.path)).toEqual(['z.md']);
  });
});

describe('fuseRanks', () => {
  it('lifts a two-source mid-rank note over a single-source top hit', () => {
    // k = adaptiveK(25) = 5. A: semantic rank 1 → 1/6 ≈ 0.167.
    // B: lexical rank 2 + expansion rank 2 → 1/7 + 0.85/7 ≈ 0.264.
    // Multi-source reinforcement must survive the expansion down-weight —
    // fusion, not raw similarity, is still the strongest relevance signal.
    const out = fuseRanks({
      sources: { semantic: ['A.md'], lexical: ['C.md', 'B.md'], expansion: ['D.md', 'B.md'] },
      totalNotes: 25,
    });
    expect(out[0].path).toBe('B.md');
    expect(out[0].sourceCount).toBe(2);
  });
  it('a direct semantic hit outranks an expansion-only hub (Moby case, 2026-08-10)', () => {
    // Live report: the expansion-only "Дата-гігієна фіду" (hub, 72 backlinks)
    // outranked the direct semantic hit whose literal name was in the query.
    // Large-k regime (k = adaptiveK(2500) = 50): 1/51 vs 0.85/51.
    const out = fuseRanks({
      sources: {
        semantic: ['Projects/Moby dick bot.md'],
        lexical: [],
        expansion: ['Tasks/Дата-гігієна фіду.md'],
      },
      totalNotes: 2500,
    });
    expect(out.map((c) => c.path)).toEqual([
      'Projects/Moby dick bot.md',
      'Tasks/Дата-гігієна фіду.md',
    ]);
  });
  it('breaks residual exact ties by path, never by backlinks', () => {
    // a.md and b.md tie exactly (both rank 1 in a weight-1 leg, sourceCount 1).
    // b.md has more backlinks; under the old comparator it won. Backlinks are
    // hub bias (see AGENTS.md anti-pattern) and no longer participate: path
    // ascending is the final, deterministic step.
    const out = fuseRanks({
      sources: { semantic: ['a.md'], lexical: ['b.md'], expansion: [] },
      totalNotes: 25,
    });
    expect(out.map((e) => e.path)).toEqual(['a.md', 'b.md']);
  });
  it('is deterministic and preserves source order under single-source degradation', () => {
    const args = {
      sources: { semantic: [], lexical: ['t.md', 'h.md', 'b.md'], expansion: [] },
      totalNotes: 1000,
    };
    expect(fuseRanks(args)).toEqual(fuseRanks(args));
    expect(fuseRanks(args).map((e) => e.path)).toEqual(['t.md', 'h.md', 'b.md']);
  });
  it('breaks an exact score tie by sourceCount', () => {
    // k = adaptiveK(25) = 5.
    // X: semantic rank 1 (index 0) → 1/(5+0+1) = 1/6. sourceCount 1.
    // Y: semantic rank 7 + lexical rank 7 (index 6 each) →
    //    1/(5+6+1) + 1/(5+6+1) = 1/12 + 1/12 = 1/6 (floating-point-exact). sourceCount 2.
    // Scores tie exactly; Y's higher sourceCount must win —
    // this exercises the sourceCount branch of the comparator, which the equal-sourceCount
    // "breaks residual exact ties..." test above cannot reach.
    const out = fuseRanks({
      sources: {
        semantic: ['X.md', 'l2.md', 'l3.md', 'l4.md', 'l5.md', 'l6.md', 'Y.md'],
        lexical: ['l1.md', 'x2.md', 'x3.md', 'x4.md', 'x5.md', 'x6.md', 'Y.md'],
        expansion: [],
      },
      totalNotes: 25,
    });
    const x = out.find((c) => c.path === 'X.md')!;
    const y = out.find((c) => c.path === 'Y.md')!;
    expect(y.score).toBe(x.score);
    expect(y.sourceCount).toBe(2);
    expect(x.sourceCount).toBe(1);
    expect(out[0].path).toBe('Y.md');
  });
  it('keeps equal-rank expansion candidates below primary hits (retention case, 2026-08-10)', () => {
    // Empty lexical leg: under equal weights semantic[i] and expansion[i] tie
    // exactly at every rank. With w_expansion < 1 the expansion contribution
    // is strictly smaller at every rank, so no primary hit can lose its slot
    // to its rank-peer expansion candidate.
    const out = fuseRanks({
      sources: {
        semantic: ['s1.md', 's2.md', 's3.md'],
        lexical: [],
        expansion: ['hub1.md', 'hub2.md', 'hub3.md'],
      },
      totalNotes: 25,
    });
    const order = out.map((c) => c.path);
    for (const [primary, hub] of [
      ['s1.md', 'hub1.md'],
      ['s2.md', 'hub2.md'],
      ['s3.md', 'hub3.md'],
    ] as const) {
      expect(order.indexOf(primary)).toBeLessThan(order.indexOf(hub));
    }
  });
});
