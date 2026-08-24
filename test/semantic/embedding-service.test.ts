import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPipeline, pipelineFactory } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  pipelineFactory: vi.fn(),
}));

pipelineFactory.mockResolvedValue(mockPipeline);

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineFactory,
}));

import { MAX_TOKENS } from '../../src/lib/obsidian/corpus/types.js';
import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';

describe('EmbeddingService', () => {
  beforeEach(() => {
    pipelineFactory.mockClear();
    mockPipeline.mockClear();
    pipelineFactory.mockResolvedValue(mockPipeline);
  });

  it('exposes initialize() and embed(text)', () => {
    const service = new EmbeddingService({ pipelineFactory });

    expect(typeof service.initialize).toBe('function');
    expect(typeof service.embed).toBe('function');
  });

  it('rejects blank query text before model invocation on a cold start', async () => {
    const service = new EmbeddingService({ pipelineFactory });

    await expect(service.embed('   ')).rejects.toThrow(/blank/i);
    expect(pipelineFactory).not.toHaveBeenCalled();
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('calls the transformers pipeline with mean pooling and normalized output', async () => {
    const mockVector = { data: new Float32Array([0.25, 0.75]) };
    mockPipeline.mockResolvedValue(mockVector);
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();
    const embedding = await service.embed('semantic query');

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith('feature-extraction', 'bge-micro-v2');
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline).toHaveBeenCalledWith('semantic query', {
      pooling: 'mean',
      normalize: true,
    });
    expect(embedding).toEqual([0.25, 0.75]);
  });

  it('rejects non-finite embedding values from the model output', async () => {
    mockPipeline.mockResolvedValue([1, Number.NaN]);
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();

    await expect(service.embed('semantic query')).rejects.toThrow(/non-finite/i);
  });

  it('initializes the model once even if initialize() is called repeatedly', async () => {
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();
    await service.initialize();
    await service.initialize();

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });
});

function fakePipeline() {
  const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
  return Object.assign(pipe, { tokenizer: { model_max_length: 1e15 } });
}

describe('EmbeddingService tokenizer cap', () => {
  it('caps the tokenizer at the model window after initialization', async () => {
    const pipe = fakePipeline();
    const service = new EmbeddingService({ pipelineFactory: async () => pipe });
    await service.embed('hello');
    // Asserted against the shared constant (the cap and EMBED_CHAR_BUDGET must
    // stay the same number) *and* against its literal value (the real window).
    expect(pipe.tokenizer.model_max_length).toBe(MAX_TOKENS);
    expect(pipe.tokenizer.model_max_length).toBe(512);
  });

  it('does not throw when the pipeline exposes no tokenizer', async () => {
    const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    const service = new EmbeddingService({ pipelineFactory: async () => pipe });
    await expect(service.embed('hello')).resolves.toHaveLength(384);
  });

  it('never raises a genuine window smaller than the cap', async () => {
    const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    const capped = Object.assign(pipe, { tokenizer: { model_max_length: 128 } });
    const service = new EmbeddingService({ pipelineFactory: async () => capped });
    await service.embed('hello');
    expect(capped.tokenizer.model_max_length).toBe(128);
  });

  it('installs the cap when the tokenizer config omits the window entirely', async () => {
    const pipe = vi.fn(async () => ({ data: new Float32Array(384) }));
    const tokenizer: { model_max_length?: number } = {};
    const bare = Object.assign(pipe, { tokenizer });
    const service = new EmbeddingService({ pipelineFactory: async () => bare });
    await service.embed('hello');
    expect(bare.tokenizer.model_max_length).toBe(MAX_TOKENS);
  });
});
