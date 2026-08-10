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
  const noBacklinks = () => 0;
  it('lifts a two-source mid-rank note over a single-source top hit', () => {
    // k = adaptiveK(25) = 5. A: semantic rank 1 → 1/6 ≈ 0.167.
    // B: lexical rank 2 + expansion rank 2 → 1/7 + 1/7 ≈ 0.286.
    const out = fuseRanks({
      sources: { semantic: ['A.md'], lexical: ['C.md', 'B.md'], expansion: ['D.md', 'B.md'] },
      totalNotes: 25,
      getBacklinkCount: noBacklinks,
    });
    expect(out[0].path).toBe('B.md');
    expect(out[0].sourceCount).toBe(2);
  });
  it('breaks score ties by source count, then backlinks, then path', () => {
    const out = fuseRanks({
      sources: { semantic: ['a.md'], lexical: ['b.md'], expansion: [] },
      totalNotes: 25,
      getBacklinkCount: (p) => (p === 'b.md' ? 3 : 0),
    });
    // рівні score (обидва rank 1 в одному джерелі) → backlinks вирішують
    expect(out.map((e) => e.path)).toEqual(['b.md', 'a.md']);
  });
  it('is deterministic and preserves source order under single-source degradation', () => {
    const args = {
      sources: { semantic: [], lexical: ['t.md', 'h.md', 'b.md'], expansion: [] },
      totalNotes: 1000,
      getBacklinkCount: noBacklinks,
    };
    expect(fuseRanks(args)).toEqual(fuseRanks(args));
    expect(fuseRanks(args).map((e) => e.path)).toEqual(['t.md', 'h.md', 'b.md']);
  });
  it('breaks an exact score tie by sourceCount before backlinks', () => {
    // k = adaptiveK(25) = 5.
    // X: semantic rank 1 (index 0) → 1/(5+0+1) = 1/6. sourceCount 1.
    // Y: lexical rank 7 + expansion rank 7 (index 6 each) →
    //    1/(5+6+1) + 1/(5+6+1) = 1/12 + 1/12 = 1/6 (floating-point-exact). sourceCount 2.
    // Scores tie exactly; X has more backlinks, but Y's higher sourceCount must win —
    // this exercises the sourceCount branch of the comparator, which the equal-sourceCount
    // "breaks score ties by source count..." test above cannot reach.
    const out = fuseRanks({
      sources: {
        semantic: ['X.md'],
        lexical: ['l1.md', 'l2.md', 'l3.md', 'l4.md', 'l5.md', 'l6.md', 'Y.md'],
        expansion: ['e1.md', 'e2.md', 'e3.md', 'e4.md', 'e5.md', 'e6.md', 'Y.md'],
      },
      totalNotes: 25,
      getBacklinkCount: (p) => (p === 'X.md' ? 10 : 0),
    });
    const x = out.find((c) => c.path === 'X.md')!;
    const y = out.find((c) => c.path === 'Y.md')!;
    expect(y.score).toBe(x.score);
    expect(y.sourceCount).toBe(2);
    expect(x.sourceCount).toBe(1);
    expect(out[0].path).toBe('Y.md');
  });
});
