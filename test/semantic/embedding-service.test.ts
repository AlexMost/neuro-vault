import { describe, expect, it, vi } from 'vitest';

import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';
import type { LocalModel } from '../../src/modules/semantic/local-model-loader.js';
import {
  identityOf,
  resolveModelProfile,
  type ModelProfile,
} from '../../src/modules/semantic/model-profiles.js';

const bge = resolveModelProfile('bge-micro-v2');
const granite = resolveModelProfile('granite-97m');

/** A model whose token state at each position is [id, 1]; the tokenizer wraps chars in [101 … 102]. */
function fakeModel(encodeImpl?: (text: string) => number[]) {
  const runs: Array<{ ids: number[][]; mask: number[][] }> = [];
  const encode = vi.fn((text: string, options: { add_special_tokens: boolean }) => {
    const body = encodeImpl ? encodeImpl(text) : Array.from(text, (c) => c.charCodeAt(0));
    return options.add_special_tokens ? [101, ...body, 102] : body;
  });
  const model: LocalModel = {
    tokenizer: { encode, padding_side: 'right', pad_token_id: 0 },
    run: async (ids, mask) => {
      runs.push({ ids, mask });
      const data: number[] = [];
      for (const row of ids) for (const id of row) data.push(id, 1);
      return { kind: 'token_states', data, dims: [ids.length, ids[0].length, 2] };
    },
  };
  return { model, runs, encode };
}

/** Same arithmetic as the implementation's normalisation, so float results compare exactly. */
const unit = (v: number[]) => {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  return v.map((x) => x / norm);
};

function serviceFor(profile: ModelProfile, model: LocalModel) {
  const loader = vi.fn(async () => model);
  return { service: new EmbeddingService({ profile, loader }), loader };
}

describe('EmbeddingService', () => {
  it('reports the identity of its profile', () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(service.identity).toEqual(identityOf(granite));
  });

  it('loads the model once, shared by concurrent embeds', async () => {
    const { service, loader } = serviceFor(granite, fakeModel().model);
    await Promise.all([service.embed('a'), service.embed('b'), service.initialize()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(granite);
  });

  it('rejects blank text before loading the model', async () => {
    const { service, loader } = serviceFor(granite, fakeModel().model);
    await expect(service.embed('   ')).rejects.toThrow(/blank/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it('pools the first token for a CLS profile', async () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(await service.embed('ab')).toEqual(unit([101, 1]));
  });

  it('pools the mean for a mean profile', async () => {
    const { service } = serviceFor(bge, fakeModel(() => [3]).model);
    expect(await service.embed('x')).toEqual(unit([(101 + 3 + 102) / 3, 1]));
  });

  it('cuts an over-long input to the profile window and still returns a vector', async () => {
    const { model, runs } = fakeModel(() => Array.from({ length: 600 }, (_, i) => i + 1000));
    const { service } = serviceFor(bge, model);
    const vector = await service.embed('long');
    expect(runs[0].ids[0]).toHaveLength(bge.maxTokens);
    expect(vector).toHaveLength(2);
  });

  it('retries a failed load on the next call', async () => {
    const { model } = fakeModel();
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(model);
    const service = new EmbeddingService({ profile: granite, loader });
    await expect(service.embed('a')).rejects.toThrow('offline');
    await expect(service.embed('a')).resolves.toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
