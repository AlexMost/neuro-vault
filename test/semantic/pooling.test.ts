import { describe, expect, it } from 'vitest';

import { poolAndNormalize, type ModelOutput } from '../../src/modules/semantic/pooling.js';

/** Token states where position j of row b holds [b*10 + j + 1, 1] — every position distinguishable. */
function states(batch: number, seq: number): ModelOutput {
  const data: number[] = [];
  for (let b = 0; b < batch; b++) for (let j = 0; j < seq; j++) data.push(b * 10 + j + 1, 1);
  return { kind: 'token_states', data, dims: [batch, seq, 2] };
}

/** Same arithmetic as the implementation's normalisation, so float results compare exactly. */
const unit = (v: number[]) => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
};

describe('poolAndNormalize', () => {
  it('cls takes the first real token under right padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[1, 1, 0]], 'cls');
    expect(row0).toEqual(unit([1, 1]));
  });

  it('cls takes the first real token under left padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[0, 1, 1]], 'cls');
    expect(row0).toEqual(unit([2, 1]));
  });

  it('last_token takes the last real token under right padding, never a pad', () => {
    const vectors = poolAndNormalize(
      states(2, 3),
      [
        [1, 1, 0],
        [1, 1, 1],
      ],
      'last_token',
    );
    expect(vectors[0]).toEqual(unit([2, 1]));
    expect(vectors[1]).toEqual(unit([13, 1]));
  });

  it('last_token takes the final column under left padding', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[0, 1, 1]], 'last_token');
    expect(row0).toEqual(unit([3, 1]));
  });

  it('mean averages real positions only', () => {
    const [row0] = poolAndNormalize(states(1, 3), [[1, 1, 0]], 'mean');
    expect(row0).toEqual(unit([1.5, 1]));
  });

  it('normalises an already-pooled output without re-pooling it', () => {
    const pooled: ModelOutput = { kind: 'pooled', data: [3, 4, 0, 5], dims: [2, 2] };
    expect(poolAndNormalize(pooled, [[1], [1, 1]], 'last_token')).toEqual([
      [0.6, 0.8],
      [0, 1],
    ]);
  });

  it('returns unit-length rows', () => {
    for (const v of poolAndNormalize(
      states(2, 4),
      [
        [1, 1, 1, 0],
        [1, 1, 1, 1],
      ],
      'mean',
    )) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    }
  });

  it('rejects a non-finite value', () => {
    const bad: ModelOutput = { kind: 'pooled', data: [Number.NaN, 1], dims: [1, 2] };
    expect(() => poolAndNormalize(bad, [[1]], 'cls')).toThrow(/non-finite/);
  });

  it('rejects a row count that disagrees with the mask', () => {
    expect(() =>
      poolAndNormalize(
        states(1, 2),
        [
          [1, 1],
          [1, 1],
        ],
        'cls',
      ),
    ).toThrow(/1 rows for 2 inputs/);
  });

  it('rejects a row with no real tokens', () => {
    expect(() => poolAndNormalize(states(1, 2), [[0, 0]], 'cls')).toThrow(/no real tokens/);
  });

  it('mean ignores left pads on a later row', () => {
    const vectors = poolAndNormalize(
      states(2, 3),
      [
        [1, 1, 1],
        [0, 1, 1],
      ],
      'mean',
    );
    expect(vectors[1]).toEqual(unit([12.5, 1]));
  });

  it('rejects a zero vector', () => {
    const zero: ModelOutput = { kind: 'pooled', data: [0, 0], dims: [1, 2] };
    expect(() => poolAndNormalize(zero, [[1]], 'cls')).toThrow(/zero vector/);
  });

  it('rejects a mask row whose length disagrees with the sequence', () => {
    expect(() => poolAndNormalize(states(1, 3), [[1, 1]], 'cls')).toThrow(
      /2 mask positions for 3 token states/,
    );
  });
});
