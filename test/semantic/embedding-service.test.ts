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
    tokenizer: { encode },
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
    await Promise.all([service.embedQuery('a'), service.embedQuery('b'), service.initialize()]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(granite);
  });

  it('rejects blank text before loading the model', async () => {
    const { service, loader } = serviceFor(granite, fakeModel().model);
    await expect(service.embedQuery('   ')).rejects.toThrow(/blank/i);
    expect(loader).not.toHaveBeenCalled();
  });

  it('pools the first token for a CLS profile', async () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(await service.embedQuery('ab')).toEqual(unit([101, 1]));
  });

  it('pools the mean for a mean profile', async () => {
    const { service } = serviceFor(bge, fakeModel(() => [3]).model);
    expect(await service.embedQuery('x')).toEqual(unit([(101 + 3 + 102) / 3, 1]));
  });

  it('cuts an over-long input to the profile window and still returns a vector', async () => {
    const { model, runs } = fakeModel(() => Array.from({ length: 600 }, (_, i) => i + 1000));
    const { service } = serviceFor(bge, model);
    const vector = await service.embedQuery('long');
    const ids = runs[0].ids[0];
    expect(ids).toHaveLength(bge.maxTokens);
    // The template is re-attached after the cut: 510 body ids (1000…1509)
    // sit between the leading [101] and the trailing [102].
    expect(ids[0]).toBe(101);
    expect(ids.at(-1)).toBe(102);
    expect(ids.at(-2)).toBe(1509);
    expect(runs[0].mask[0]).toHaveLength(bge.maxTokens);
    expect(runs[0].mask[0].every((m) => m === 1)).toBe(true);
    expect(vector).toHaveLength(2);
  });

  it('retries a failed load on the next call', async () => {
    const { model } = fakeModel();
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(model);
    const service = new EmbeddingService({ profile: granite, loader });
    await expect(service.embedQuery('a')).rejects.toThrow('offline');
    await expect(service.embedQuery('a')).resolves.toHaveLength(2);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('splits query and document embedding, with at most maxBatchSize documents per call', async () => {
    const { service } = serviceFor(granite, fakeModel().model);
    expect(service.maxBatchSize).toBe(8);
    expect(await service.embedQuery('ab')).toEqual(unit([101, 1]));
    expect(await service.embedDocuments(['ab', 'cd'])).toHaveLength(2);
    await expect(service.embedDocuments(Array.from({ length: 9 }, () => 'x'))).rejects.toThrow(
      'embedDocuments takes at most 8 texts, got 9',
    );
  });
});

const lastTokenProfile: ModelProfile = {
  key: 'test-last-token',
  repo: 'test/repo',
  revision: '0'.repeat(40),
  dtype: 'q8',
  dims: 2,
  pooling: 'last_token',
  queryPrefix: 'Q: ',
  documentPrefix: '',
  maxTokens: 8,
};

/** bos=2 / eos=1 tokenizer padding with 0 on `side`; token state at each position is [id, 1]. */
function templatedModel(side: 'left' | 'right' = 'right') {
  const runs: Array<{ ids: number[][]; mask: number[][] }> = [];
  const encode = vi.fn((text: string, { add_special_tokens }: { add_special_tokens: boolean }) => {
    const raw = Array.from(text, (c) => c.charCodeAt(0));
    return add_special_tokens ? [2, ...raw, 1] : raw;
  });
  const model: LocalModel = {
    tokenizer: { encode, padding_side: side, pad_token_id: 0 },
    run: async (ids, mask) => {
      runs.push({ ids, mask });
      const data: number[] = [];
      for (const row of ids) for (const id of row) data.push(id, 1);
      return { kind: 'token_states', data, dims: [ids.length, ids[0].length, 2] };
    },
  };
  return { model, runs, encode };
}

describe('EmbeddingService — template-aware batches', () => {
  it('keeps the end-of-sequence token of an over-long document', async () => {
    const { model, runs } = templatedModel();
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    const [vector] = await service.embedDocuments(['abcdefghijklmnop']);
    expect(runs[0].ids[0]).toEqual([2, 97, 98, 99, 100, 101, 102, 1]);
    expect(vector).toEqual(unit([1, 1]));
  });

  it('gives a text the same vector alone and in a batch with longer texts', async () => {
    const { model } = templatedModel('right');
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    const [alone] = await service.embedDocuments(['ab']);
    const [batched] = await service.embedDocuments(['ab', 'abcdef']);
    expect(batched).toEqual(alone);
  });

  it('pads on the side the tokenizer declares', async () => {
    const { model, runs } = templatedModel('left');
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    await service.embedDocuments(['ab', 'abcd']);
    expect(runs[0].ids[0]).toEqual([0, 0, 2, 97, 98, 1]);
  });

  it('applies the query prefix to queries only', async () => {
    const { model, encode } = templatedModel();
    const service = new EmbeddingService({ profile: lastTokenProfile, loader: async () => model });
    await service.embedQuery('x');
    await service.embedDocuments(['x']);
    const raw = encode.mock.calls.filter(([, o]) => !o.add_special_tokens).map(([t]) => t);
    expect(raw).toContain('Q: x');
    expect(raw).toContain('x');
  });

  it('rejects a blank document, naming its index, before loading', async () => {
    const loader = vi.fn(async () => templatedModel().model);
    const service = new EmbeddingService({ profile: lastTokenProfile, loader });
    await expect(service.embedDocuments(['ok', '   '])).rejects.toThrow('document 1 is blank');
    expect(loader).not.toHaveBeenCalled();
  });

  it('returns no vectors for no documents without loading', async () => {
    const loader = vi.fn(async () => templatedModel().model);
    const service = new EmbeddingService({ profile: lastTokenProfile, loader });
    expect(await service.embedDocuments([])).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
  });
});
