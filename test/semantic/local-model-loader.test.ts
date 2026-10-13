import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createLocalModelLoader,
  defaultModelCacheDir,
  type TransformersModule,
} from '../../src/modules/semantic/local-model-loader.js';
import { resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';

const granite = resolveModelProfile('granite-97m');

class FakeTensor {
  constructor(
    public type: string,
    public data: BigInt64Array,
    public dims: number[],
  ) {}
}

function fakeTransformers(
  opts: {
    inputNames?: string[];
    outputNames?: string[];
    outputs?: Record<string, { data: number[]; dims: number[] }>;
  } = {},
) {
  const forward: Array<Record<string, FakeTensor>> = [];
  const model = Object.assign(
    async (inputs: Record<string, FakeTensor>) => {
      forward.push(inputs);
      return opts.outputs ?? { last_hidden_state: { data: [1, 2], dims: [1, 1, 2] } };
    },
    {
      sessions: {
        model: {
          inputNames: opts.inputNames ?? ['input_ids', 'attention_mask'],
          outputNames: opts.outputNames ?? ['last_hidden_state'],
        },
      },
    },
  );
  const tokenizer = { encode: () => [1], padding_side: 'right', pad_token_id: 0 };
  const tf = {
    env: { cacheDir: null as string | null, logLevel: undefined as unknown },
    LogLevel: { ERROR: 'error-level' },
    AutoTokenizer: { from_pretrained: vi.fn(async () => tokenizer) },
    AutoModel: { from_pretrained: vi.fn(async () => model) },
    Tensor: FakeTensor,
  };
  return { tf, forward, module: tf as unknown as TransformersModule };
}

describe('defaultModelCacheDir', () => {
  it('uses an absolute XDG_CACHE_HOME', () => {
    expect(defaultModelCacheDir({ XDG_CACHE_HOME: '/xdg' }, '/home/u')).toBe(
      path.join('/xdg', 'neuro-vault', 'models'),
    );
  });

  it('ignores a relative XDG_CACHE_HOME, as the XDG spec requires', () => {
    expect(defaultModelCacheDir({ XDG_CACHE_HOME: 'rel/cache' }, '/home/u')).toBe(
      path.join('/home/u', '.cache', 'neuro-vault', 'models'),
    );
  });

  it('falls back to ~/.cache when XDG_CACHE_HOME is unset', () => {
    expect(defaultModelCacheDir({}, '/home/u')).toBe(
      path.join('/home/u', '.cache', 'neuro-vault', 'models'),
    );
  });
});

describe('createLocalModelLoader', () => {
  it('sets the global cache dir and log level before loading', async () => {
    const { tf, module } = fakeTransformers();
    await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/models' })(
      granite,
    );
    expect(tf.env.cacheDir).toBe('/models');
    expect(tf.env.logLevel).toBe('error-level');
  });

  it('loads tokenizer and model at the pinned revision, int8, on CPU', async () => {
    const { tf, module } = fakeTransformers();
    await createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(
      granite,
    );
    expect(tf.AutoTokenizer.from_pretrained).toHaveBeenCalledWith(granite.repo, {
      revision: granite.revision,
    });
    expect(tf.AutoModel.from_pretrained).toHaveBeenCalledWith(granite.repo, {
      revision: granite.revision,
      dtype: 'q8',
      device: 'cpu',
    });
  });

  it('fails naming the profile when the export lacks a required input', async () => {
    const { module } = fakeTransformers({ inputNames: ['input_ids'] });
    await expect(
      createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite),
    ).rejects.toThrow(
      'model "granite-97m": export lacks the "attention_mask" input (has: input_ids)',
    );
  });

  it('fails naming the profile when the export has no usable output', async () => {
    const { module } = fakeTransformers({ outputNames: ['logits'] });
    await expect(
      createLocalModelLoader({ importTransformers: async () => module, cacheDir: '/m' })(granite),
    ).rejects.toThrow('model "granite-97m": export has no usable output (has: logits)');
  });

  it('runs a forward pass on int64 tensors and returns token states', async () => {
    const { forward, module } = fakeTransformers();
    const model = await createLocalModelLoader({
      importTransformers: async () => module,
      cacheDir: '/m',
    })(granite);
    const output = await model.run([[5, 6]], [[1, 1]]);
    expect(output).toEqual({ kind: 'token_states', data: [1, 2], dims: [1, 1, 2] });
    expect(forward[0].input_ids.type).toBe('int64');
    expect([...forward[0].input_ids.data]).toEqual([5n, 6n]);
    expect(forward[0].attention_mask.dims).toEqual([1, 2]);
  });

  it('prefers token states over a pooled output when both exist', async () => {
    const { module } = fakeTransformers({
      outputNames: ['sentence_embedding', 'last_hidden_state'],
      outputs: {
        sentence_embedding: { data: [9, 9], dims: [1, 2] },
        last_hidden_state: { data: [1, 2], dims: [1, 1, 2] },
      },
    });
    const model = await createLocalModelLoader({
      importTransformers: async () => module,
      cacheDir: '/m',
    })(granite);
    expect((await model.run([[1]], [[1]])).kind).toBe('token_states');
  });

  it('falls back to the pooled output when the export has no token states', async () => {
    const { module } = fakeTransformers({
      outputNames: ['sentence_embedding'],
      outputs: { sentence_embedding: { data: [3, 4], dims: [1, 2] } },
    });
    const model = await createLocalModelLoader({
      importTransformers: async () => module,
      cacheDir: '/m',
    })(granite);
    expect(await model.run([[1]], [[1]])).toEqual({ kind: 'pooled', data: [3, 4], dims: [1, 2] });
  });
});
