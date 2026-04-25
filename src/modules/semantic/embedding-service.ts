import { pipeline } from '@xenova/transformers';

import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL_KEY = 'bge-micro-v2';
const EMBEDDING_TASK = 'feature-extraction';

type RawPipeline = (
  text: string,
  options: { pooling: 'mean'; normalize: true },
) => Promise<unknown>;

type PipelineFactory = (task: string, model: string) => Promise<RawPipeline>;

export interface EmbeddingServiceOptions {
  modelKey?: string;
  pipelineFactory?: PipelineFactory;
}

export class EmbeddingService implements EmbeddingProvider {
  private readonly modelKey: string;

  private readonly pipelineFactory: PipelineFactory;

  private pipeline?: RawPipeline;

  private initialization: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.modelKey = options.modelKey ?? DEFAULT_MODEL_KEY;
    this.pipelineFactory = options.pipelineFactory ?? (pipeline as unknown as PipelineFactory);
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
    const result = await embeddingPipeline(normalizedText, {
      pooling: 'mean',
      normalize: true,
    });
    return this.normalizeEmbedding(result);
  }

  private async getPipeline(): Promise<RawPipeline> {
    if (this.pipeline) {
      return this.pipeline;
    }

    if (!this.initialization) {
      this.initialization = this.pipelineFactory(EMBEDDING_TASK, this.modelKey)
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
      return Array.from(embedding as unknown as ArrayLike<unknown>, (value, index) =>
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
