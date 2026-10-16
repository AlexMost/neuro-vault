import type { Pooling } from '../../lib/model-profiles.js';

/** A model's output for one batch, as plain data — no transformers.js types cross this seam. */
export interface ModelOutput {
  /** `token_states`: dims `[batch, seq, hidden]`. `pooled`: dims `[batch, hidden]`, pooled inside the graph. */
  kind: 'token_states' | 'pooled';
  data: ArrayLike<number>;
  dims: number[];
}

function copy(data: ArrayLike<number>, start: number, length: number): number[] {
  const out = new Array<number>(length);
  for (let i = 0; i < length; i++) out[i] = Number(data[start + i]);
  return out;
}

function normalize(values: number[]): number[] {
  let sumSquares = 0;
  values.forEach((v, i) => {
    if (!Number.isFinite(v))
      throw new Error(`model output holds a non-finite value at dimension ${i}`);
    sumSquares += v * v;
  });
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) throw new Error('model output is a zero vector');
  return values.map((v) => v / norm);
}

/**
 * One unit-length vector per input row. Positions come from the attention
 * mask, never from token ids: a tokenizer may pad with the very id its
 * template appends (harrier-0.6b pads with `<|endoftext|>`), so only the mask
 * can tell the last real token from a pad.
 */
export function poolAndNormalize(
  output: ModelOutput,
  mask: number[][],
  method: Pooling,
): number[][] {
  const batch = output.dims[0] ?? 0;
  if (batch !== mask.length) {
    throw new Error(`model returned ${batch} rows for ${mask.length} inputs`);
  }

  if (output.kind === 'pooled') {
    const hidden = output.dims[1] ?? 0;
    return mask.map((_, b) => normalize(copy(output.data, b * hidden, hidden)));
  }

  const seq = output.dims[1] ?? 0;
  const hidden = output.dims[2] ?? 0;
  return mask.map((rowMask, b) => {
    if (rowMask.length !== seq) {
      throw new Error(`input ${b} has ${rowMask.length} mask positions for ${seq} token states`);
    }
    const real: number[] = [];
    rowMask.forEach((m, j) => {
      if (m === 1) real.push(j);
    });
    if (real.length === 0) throw new Error(`input ${b} has no real tokens`);
    const at = (position: number): number[] =>
      copy(output.data, (b * seq + position) * hidden, hidden);

    if (method === 'cls') return normalize(at(real[0]));
    if (method === 'last_token') return normalize(at(real[real.length - 1]));
    // Summed straight from the output: a copy per token is one throwaway array per position.
    const sum = new Array<number>(hidden).fill(0);
    for (const position of real) {
      const start = (b * seq + position) * hidden;
      for (let i = 0; i < hidden; i++) sum[i] += Number(output.data[start + i]);
    }
    return normalize(sum.map((v) => v / real.length));
  });
}
