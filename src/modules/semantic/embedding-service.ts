import type { EmbeddingIdentity } from '../../lib/obsidian/corpus/types.js';

import {
  createLocalModelLoader,
  type LocalModel,
  type LocalModelLoader,
} from './local-model-loader.js';
import { identityOf, type ModelProfile } from './model-profiles.js';
import { poolAndNormalize } from './pooling.js';
import type { EmbeddingProvider } from './types.js';

export interface EmbeddingServiceOptions {
  profile: ModelProfile;
  /** Injected by tests; production loads through transformers.js. */
  loader?: LocalModelLoader;
}

/** The local, in-process embedding provider for one model profile. */
export class EmbeddingService implements EmbeddingProvider {
  readonly identity: EmbeddingIdentity;

  readonly maxBatchSize = 8;

  private readonly profile: ModelProfile;

  private readonly loader: LocalModelLoader;

  private model?: LocalModel;

  private initialization: Promise<void> | null = null;

  constructor(options: EmbeddingServiceOptions) {
    // `embedOne` has no query/document distinction yet (design D4, PR 2), so a
    // prefix would be silently dropped. Refuse the profile instead.
    if (options.profile.queryPrefix !== '' || options.profile.documentPrefix !== '') {
      throw new Error(
        `model "${options.profile.key}": query/document prefixes are not supported yet`,
      );
    }
    this.profile = options.profile;
    this.loader = options.loader ?? createLocalModelLoader();
    this.identity = identityOf(options.profile);
  }

  async initialize(): Promise<void> {
    await this.getModel();
  }

  embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length > this.maxBatchSize) {
      throw new Error(
        `embedDocuments takes at most ${this.maxBatchSize} texts, got ${texts.length}`,
      );
    }
    const vectors: number[][] = [];
    for (const text of texts) vectors.push(await this.embedOne(text));
    return vectors;
  }

  private async embedOne(text: string): Promise<number[]> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      throw new Error('Embedding text must not be blank');
    }

    const model = await this.getModel();
    // The encoding v2's pipeline used: special tokens first, then the cut to
    // the window. It drops the trailing special token of an over-long input,
    // which mean and CLS pooling tolerate — and it keeps vectors comparable
    // with corpora that v2 built (design D5, "Staging").
    const ids = model.tokenizer
      .encode(normalizedText, { add_special_tokens: true })
      .slice(0, this.profile.maxTokens);
    const mask = [ids.map(() => 1)];
    const [vector] = poolAndNormalize(await model.run([ids], mask), mask, this.profile.pooling);
    if (vector === undefined) throw new Error('Embedding model returned no vector');
    return vector;
  }

  private async getModel(): Promise<LocalModel> {
    if (this.model) return this.model;

    if (!this.initialization) {
      this.initialization = this.loader(this.profile)
        .then((model) => {
          this.model = model;
        })
        .catch((error: unknown) => {
          // A failed load must not be cached: the next call retries.
          this.initialization = null;
          throw error;
        });
    }

    await this.initialization;
    if (!this.model) throw new Error('Embedding model failed to initialize');
    return this.model;
  }
}
