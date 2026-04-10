import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPipeline, pipelineFactory } = vi.hoisted(() => ({
  mockPipeline: vi.fn(),
  pipelineFactory: vi.fn(),
}));

pipelineFactory.mockResolvedValue(mockPipeline);

vi.mock('@xenova/transformers', () => ({
  pipeline: pipelineFactory,
}));

import { EmbeddingService } from '../src/embedding-service.js';

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

  it('rejects blank query text before model invocation', async () => {
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();

    await expect(service.embed('   ')).rejects.toThrow(/blank/i);
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('calls the transformers pipeline with mean pooling and normalized output', async () => {
    const mockVector = [0.25, 0.75];
    mockPipeline.mockResolvedValue(mockVector);
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();
    const embedding = await service.embed('semantic query');

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
    expect(pipelineFactory).toHaveBeenCalledWith('feature-extraction', 'bge-micro-v2', {
      pooling: 'mean',
      normalize: true,
    });
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline).toHaveBeenCalledWith('semantic query');
    expect(embedding).toEqual(mockVector);
  });

  it('initializes the model once even if initialize() is called repeatedly', async () => {
    const service = new EmbeddingService({ pipelineFactory });

    await service.initialize();
    await service.initialize();
    await service.initialize();

    expect(pipelineFactory).toHaveBeenCalledTimes(1);
  });
});
