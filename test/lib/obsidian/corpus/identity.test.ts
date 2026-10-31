import { describe, expect, it } from 'vitest';

import {
  corpusIdentityOf,
  formatIdentity,
  formatRebuild,
  identityMatches,
  isStoredManifest,
} from '../../../../src/lib/obsidian/corpus/identity.js';
import { TEST_IDENTITY } from '../../../_identity.js';

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
      embed_version: 3,
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
      stored: 'granite-97m (embed_version 3)',
      active: 'harrier-270m (embed_version 3)',
    });
  });

  it('names the differing fields when model and version agree', () => {
    const stored = { ...active, revision: 'old-revision', dtype: 'fp32', created };
    expect(formatRebuild(stored, active)).toEqual({
      stored: 'harrier-270m (embed_version 3, revision old-revision, dtype fp32)',
      active: 'harrier-270m (embed_version 3, revision new-revision, dtype q8)',
    });
  });

  it('marks a producer field a legacy manifest lacks as unset', () => {
    const { provider: _provider, ...legacy } = active;
    expect(formatRebuild(legacy, active).stored).toBe(
      'harrier-270m (embed_version 3, provider unset)',
    );
  });

  it('describes a missing manifest without comparing fields', () => {
    expect(formatRebuild(null, active).stored).toBe('an unreadable or missing manifest');
  });
});

describe('identityMatches', () => {
  it('matches when every identity field agrees, whatever else is recorded', () => {
    expect(identityMatches(TEST_IDENTITY, TEST_IDENTITY)).toBe(true);
    const manifest = { ...TEST_IDENTITY, created: 'x' };
    expect(identityMatches(manifest, TEST_IDENTITY)).toBe(true);
  });

  it('does not match when one identity field differs', () => {
    expect(identityMatches({ ...TEST_IDENTITY, revision: 'other' }, TEST_IDENTITY)).toBe(false);
    expect(identityMatches({ ...TEST_IDENTITY, embed_version: 1 }, TEST_IDENTITY)).toBe(false);
  });

  it('does not match a corpus recorded under embed_version 2, before the last-line span fix', () => {
    expect(identityMatches({ ...TEST_IDENTITY, embed_version: 2 }, TEST_IDENTITY)).toBe(false);
  });

  it('does not match a legacy identity that lacks a producer field', () => {
    const { pooling: _pooling, ...legacy } = TEST_IDENTITY;
    expect(identityMatches(legacy, TEST_IDENTITY)).toBe(false);
  });

  it('never matches nothing on record', () => {
    expect(identityMatches(null, TEST_IDENTITY)).toBe(false);
  });
});

describe('isStoredManifest', () => {
  it('accepts a v2 manifest and a legacy v1 one', () => {
    expect(isStoredManifest({ ...TEST_IDENTITY, created: 'x' })).toBe(true);
    expect(
      isStoredManifest({
        embed_version: 1,
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        dims: 384,
        strategy: 'sc-parity-v1',
        created: '2026-08-25T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('rejects a manifest without a model key, or with a mistyped optional field', () => {
    const { model_key: _dropped, ...withoutKey } = { ...TEST_IDENTITY, created: 'x' };
    expect(isStoredManifest(withoutKey)).toBe(false);
    expect(isStoredManifest({ ...TEST_IDENTITY, created: 'x', revision: 7 })).toBe(false);
    expect(isStoredManifest(null)).toBe(false);
    expect(isStoredManifest('manifest')).toBe(false);
  });
});
