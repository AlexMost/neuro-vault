import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

import {
  createLocalModelLoader,
  type LocalModel,
  type LocalModelLoader,
} from './local-model-loader.js';
import { identityOf, type ModelProfile } from '../../lib/model-profiles.js';
import { poolAndNormalize } from './pooling.js';
import { encodeRow, padBatch } from './tokenization.js';
import type { EmbeddingProvider } from './types.js';

export interface EmbeddingServiceOptions {
  profile: ModelProfile;
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

interface Loaded {
  model: LocalModel;
  padId: number;
  padSide: 'left' | 'right';
}

/** The most texts one in-process `embedDocuments` call takes. */
export const LOCAL_MAX_BATCH_SIZE = 8;

/** The local, in-process embedding provider for one model profile. */
export class EmbeddingService implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;

  readonly maxBatchSize = LOCAL_MAX_BATCH_SIZE;

  private readonly profile: ModelProfile;

  private readonly loader: LocalModelLoader;

  private loaded?: Loaded;

  private initialization: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions) {
    this.profile = options.profile;
    this.loader = options.loader ?? createLocalModelLoader();
    this.identity = identityOf(options.profile);
  }

  async initialize(): Promise<void> {
    await this.getLoaded();
  }

  async embedQuery(text: string): Promise<number[]> {
    const content = text.trim();
    if (!content) throw new Error('Embedding text must not be blank');
    const [vector] = await this.embedRows([content], this.profile.queryPrefix);
    if (vector === undefined) throw new Error('Embedding model returned no vector');
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length > this.maxBatchSize) {
      throw new Error(
        `embedDocuments takes at most ${this.maxBatchSize} texts, got ${texts.length}`,
      );
    }
    if (texts.length === 0) return [];
    const contents = texts.map((text, index) => {
      const content = text.trim();
      if (!content) throw new Error(`document ${index} is blank`);
      return content;
    });
    return this.embedRows(contents, this.profile.documentPrefix);
  }

  /** Template-aware rows, padded on the tokenizer's side, pooled by mask (design D5). */
  private async embedRows(contents: string[], prefix: string): Promise<number[][]> {
    const { model, padId, padSide } = await this.getLoaded();
    const rows = contents.map((content) =>
      encodeRow({
        prefix,
        content,
        template: model.template,
        maxTokens: this.profile.maxTokens,
        encoder: model.tokenizer,
      }),
    );
    const { ids, mask } = padBatch(rows, padId, padSide);
    return poolAndNormalize(await model.run(ids, mask), mask, this.profile.pooling);
  }

  private async getLoaded(): Promise<Loaded> {
    if (this.loaded) return this.loaded;

    if (!this.initialization) {
      this.initialization = this.loader(this.profile)
        .then((model) => {
          this.loaded = {
            model,
            padId: model.tokenizer.pad_token_id ?? 0,
            padSide: model.tokenizer.padding_side === 'left' ? 'left' : 'right',
          };
        })
        .catch((error: unknown) => {
          // A failed load must not be cached: the next call retries.
          this.initialization = null;
          throw error;
        });
    }

    await this.initialization;
    if (!this.loaded) throw new Error('Embedding model failed to initialize');
    return this.loaded;
  }
}
