import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPipeline, pipelineFactory } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  pipelineFactory: vi.fn(),
}));

pipelineFactory.mockResolvedValue(mockPipeline);

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineFactory,
}));

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
