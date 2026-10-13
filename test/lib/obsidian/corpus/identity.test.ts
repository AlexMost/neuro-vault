import { describe, expect, it } from 'vitest';

import { corpusIdentityOf, formatIdentity } from '../../../../src/lib/obsidian/corpus/identity.js';

describe('corpusIdentityOf', () => {
  it('records the producing model under this build’s extraction version and strategy', () => {
    expect(
      corpusIdentityOf({
        provider: 'transformers.js',
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
        dtype: 'q8',
        dims: 384,
        pooling: 'mean',
        max_tokens: 512,
      }),
    ).toEqual({
      embed_version: 1,
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      dims: 384,
      strategy: 'sc-parity-v1',
    });
  });
});

describe('formatIdentity', () => {
  it('names the model and the embedding version', () => {
    expect(formatIdentity({ model_key: 'bge-micro-v2', embed_version: 1 })).toBe(
      'bge-micro-v2 (embed_version 1)',
    );
  });

  it('describes a corpus whose manifest could not be read', () => {
    expect(formatIdentity(null)).toBe('an unreadable or missing manifest');
  });
});
