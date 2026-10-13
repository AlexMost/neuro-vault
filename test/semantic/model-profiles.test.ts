import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_KEY,
  LOCAL_PROVIDER,
  MODEL_KEYS,
  identityOf,
  resolveModelProfile,
} from '../../src/modules/semantic/model-profiles.js';

describe('model profile registry', () => {
  it('holds exactly the verified profiles, bge-micro-v2 by default', () => {
    expect([...MODEL_KEYS].sort()).toEqual(['bge-micro-v2', 'granite-97m']);
    expect(DEFAULT_MODEL_KEY).toBe('bge-micro-v2');
  });

  it('pins every profile to an exact 40-hex revision, int8', () => {
    for (const key of MODEL_KEYS) {
      const profile = resolveModelProfile(key);
      expect(profile.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(profile.dtype).toBe('q8');
    }
  });

  it('rejects an unknown key, listing the allowed ones', () => {
    expect(() => resolveModelProfile('bge-m3')).toThrow(
      'unknown model "bge-m3" — choose one of: bge-micro-v2, granite-97m',
    );
  });

  it('does not accept a repository id as a key', () => {
    expect(() => resolveModelProfile('TaylorAI/bge-micro-v2')).toThrow(/unknown model/);
  });

  it('does not resolve inherited object keys', () => {
    expect(() => resolveModelProfile('toString')).toThrow(/unknown model/);
    expect(() => resolveModelProfile('__proto__')).toThrow(/unknown model/);
  });

  it('describes granite-97m as the lite CLS profile', () => {
    expect(resolveModelProfile('granite-97m')).toMatchObject({
      repo: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
      revision: '536a9f241cb3f02a9c5995a1e708c784bd274859',
      dims: 384,
      pooling: 'cls',
      queryPrefix: '',
      documentPrefix: '',
      maxTokens: 512,
    });
  });

  it("reproduces today's corpus identity for bge-micro-v2", () => {
    expect(identityOf(resolveModelProfile('bge-micro-v2'))).toEqual({
      provider: LOCAL_PROVIDER,
      model_key: 'bge-micro-v2',
      model_id: 'TaylorAI/bge-micro-v2',
      revision: '3edf6d7de0faa426b09780416fe61009f26ae589',
      dtype: 'q8',
      dims: 384,
      pooling: 'mean',
      max_tokens: 512,
    });
  });
});
