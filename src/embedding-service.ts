import { pipeline } from '@xenova/transformers';

import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const EMBEDDING_TASK = 'feature-extraction';

type EmbeddingPipeline = (text: string) => Promise<unknown>;

type EmbeddingPipelineFactory = (
  task: string,
  model: string,
  options: {
    pooling: 'mean';
    normalize: true;
  },
) => Promise<EmbeddingPipeline>;

export interface EmbeddingServiceOptions {
  modelKey?: string;
  pipelineFactory?: EmbeddingPipelineFactory;
}

export class EmbeddingService implements EmbeddingProvider {
  private readonly modelKey: string;

  private readonly pipelineFactory: EmbeddingPipelineFactory;

  private pipeline?: EmbeddingPipeline;

  private initialization: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.modelKey = options.modelKey ?? DEFAULT_MODEL_KEY;
    this.pipelineFactory =
      options.pipelineFactory ?? (pipeline as unknown as EmbeddingPipelineFactory);
  }

  async initialize(): Promise<void> {
    await this.getPipeline();
  }

  async embed(text: string): Promise<number[]> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error('Embedding text must not be blank');
    }

    const embeddingPipeline = await this.getPipeline();
    return this.normalizeEmbedding(await embeddingPipeline(normalizedText));
  }

  private async getPipeline(): Promise<EmbeddingPipeline> {
    if (this.pipeline) {
      return this.pipeline;
    }

    if (!this.initialization) {
      this.initialization = this.pipelineFactory(EMBEDDING_TASK, this.modelKey, {
        pooling: 'mean',
        normalize: true,
      })
        .then((embeddingPipeline) => {
          this.pipeline = embeddingPipeline;
        })
        .catch((error: unknown) => {
          this.initialization = null;
          throw error;
        });
    }

    await this.initialization;

    if (!this.pipeline) {
      throw new Error('Embedding pipeline failed to initialize');
    }

    return this.pipeline;
  }

  private normalizeEmbedding(embedding: unknown): number[] {
    if (Array.isArray(embedding)) {
      return embedding.map((value, index) =>
        this.normalizeEmbeddingValue(value, `embedding[${index}]`),
      );
    }

    if (ArrayBuffer.isView(embedding)) {
      return Array.from(embedding as ArrayLike<unknown>, (value, index) =>
        this.normalizeEmbeddingValue(value, `embedding[${index}]`),
      );
    }

    if (
      embedding !== null &&
      typeof embedding === 'object' &&
      'data' in embedding &&
      ArrayBuffer.isView((embedding as { data: unknown }).data)
    ) {
      return Array.from((embedding as { data: ArrayLike<unknown> }).data, (value, index) =>
        this.normalizeEmbeddingValue(value, `embedding.data[${index}]`),
      );
    }

    throw new Error('Embedding pipeline returned an unsupported value');
  }

  private normalizeEmbeddingValue(value: unknown, label: string): number {
    const numericValue =
      typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : NaN;

    if (!Number.isFinite(numericValue)) {
      throw new Error(`Embedding pipeline returned a non-finite value at ${label}`);
    }

    return numericValue;
  }
}
