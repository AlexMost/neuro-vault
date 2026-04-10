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
      return embedding.map((value) => Number(value));
    }

    if (ArrayBuffer.isView(embedding)) {
      return Array.from(embedding as ArrayLike<number>, (value) => Number(value));
    }

    if (
      embedding !== null &&
      typeof embedding === 'object' &&
      'data' in embedding &&
      ArrayBuffer.isView((embedding as { data: unknown }).data)
    ) {
      return Array.from(
        (embedding as { data: ArrayLike<number> }).data,
        (value) => Number(value),
      );
    }

    throw new Error('Embedding pipeline returned an unsupported value');
  }
}
