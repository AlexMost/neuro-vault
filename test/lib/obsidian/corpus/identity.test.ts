import { describe, expect, it } from 'vitest';

import {
  corpusIdentityOf,
  formatIdentity,
  formatRebuild,
} from '../../../../src/lib/obsidian/corpus/identity.js';

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
      embed_version: 2,
      provider: 'transformers.js',
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
      dtype: 'q8',
      dims: 384,
      pooling: 'mean',
      max_tokens: 512,
      strategy: 'token-window-v1',
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

describe('formatRebuild', () => {
  const active = corpusIdentityOf({
    provider: 'transformers.js',
    model_key: 'harrier-270m',
    model_id: 'onnx-community/harrier-oss-v1-270m-ONNX',
    revision: 'new-revision',
    dtype: 'q8',
    dims: 640,
    pooling: 'last_token',
    max_tokens: 512,
  });
  const created = '2026-10-13T00:00:00.000Z';

  it('names each side by model and version when those differ', () => {
    const stored = { ...active, model_key: 'granite-97m', created };
    expect(formatRebuild(stored, active)).toEqual({
      stored: 'granite-97m (embed_version 2)',
      active: 'harrier-270m (embed_version 2)',
    });
  });

  it('names the differing fields when model and version agree', () => {
    const stored = { ...active, revision: 'old-revision', dtype: 'fp32', created };
    expect(formatRebuild(stored, active)).toEqual({
      stored: 'harrier-270m (embed_version 2, revision old-revision, dtype fp32)',
      active: 'harrier-270m (embed_version 2, revision new-revision, dtype q8)',
    });
  });

  it('marks a producer field a legacy manifest lacks as unset', () => {
    const { provider: _provider, ...legacy } = active;
    expect(formatRebuild({ ...legacy, created }, active).stored).toBe(
      'harrier-270m (embed_version 2, provider unset)',
    );
  });

  it('describes a missing manifest without comparing fields', () => {
    expect(formatRebuild(null, active).stored).toBe('an unreadable or missing manifest');
  });
});
