import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_KEY,
  LOCAL_PROVIDER,
  MODEL_KEYS,
  identityOf,
  resolveModelProfile,
  type SimilarityDefaults,
} from '../../src/lib/model-profiles.js';

/**
 * Copied from calibration.md, "Chosen values"; harrier-270m's note floors and fallback from the
 * semantic-floor-recalibration design (D2, D3). A retune edits the profile, this pin and the
 * thresholds tables in docs/ together.
 */
const CALIBRATED_SIMILARITY: Record<string, SimilarityDefaults> = {
  'harrier-270m': {
    quick: 0.45,
    deep: 0.45,
    blockFloor: 0.13,
    expansionFloor: 0.2,
    similarNotes: 0.22,
    duplicates: 0.77,
  },
  'granite-97m': {
    quick: 0.71,
    deep: 0.66,
    fallback: 0.65,
    blockFloor: 0.66,
    expansionFloor: 0.65,
    similarNotes: 0.67,
    duplicates: 0.9,
  },
  'harrier-0.6b': {
    quick: 0.25,
    deep: 0.19,
    fallback: 0.15,
    blockFloor: 0.19,
    expansionFloor: 0.25,
    similarNotes: 0.29,
    duplicates: 0.76,
  },
};

describe('model profile registry', () => {
  it('holds exactly the verified profiles, harrier-270m by default', () => {
    expect([...MODEL_KEYS].sort()).toEqual(['granite-97m', 'harrier-0.6b', 'harrier-270m']);
    expect(DEFAULT_MODEL_KEY).toBe('harrier-270m');
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
      'unknown model "bge-m3" — choose one of: harrier-270m, granite-97m, harrier-0.6b',
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

  const HARRIER_PREFIX =
    'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';

  it('describes harrier-270m as a last-token profile with the instruction prefix', () => {
    expect(resolveModelProfile('harrier-270m')).toMatchObject({
      repo: 'onnx-community/harrier-oss-v1-270m-ONNX',
      revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
      dims: 640,
      pooling: 'last_token',
      queryPrefix: HARRIER_PREFIX,
      documentPrefix: '',
      maxTokens: 512,
    });
  });

  it('describes harrier-0.6b as the quality profile', () => {
    expect(resolveModelProfile('harrier-0.6b')).toMatchObject({
      repo: 'onnx-community/harrier-oss-v1-0.6b-ONNX',
      revision: 'e4daffa011e666dcd2ff2a3c6c05084090ac314d',
      dims: 1024,
      pooling: 'last_token',
      queryPrefix: HARRIER_PREFIX,
      documentPrefix: '',
      maxTokens: 512,
    });
  });

  it('reports the corpus identity for harrier-270m', () => {
    expect(identityOf(resolveModelProfile('harrier-270m'))).toEqual({
      provider: LOCAL_PROVIDER,
      model_key: 'harrier-270m',
      model_id: 'onnx-community/harrier-oss-v1-270m-ONNX',
      revision: 'd59c919d0159aea2c19ed7d04288fcdd048d0f9c',
      dtype: 'q8',
      dims: 640,
      pooling: 'last_token',
      max_tokens: 512,
    });
  });

  it('carries similarity defaults on every profile, ordered quick ≥ deep > fallback where one exists', () => {
    for (const key of MODEL_KEYS) {
      const { quick, deep, fallback } = resolveModelProfile(key).similarity;
      expect(quick).toBeGreaterThanOrEqual(deep);
      if (fallback !== undefined) expect(deep).toBeGreaterThan(fallback);
    }
  });

  it('harrier-270m defines no fallback', () => {
    expect('fallback' in resolveModelProfile('harrier-270m').similarity).toBe(false);
  });

  it('pins the calibrated similarity defaults (calibration.md, "Chosen values")', () => {
    const chosen = Object.fromEntries(
      MODEL_KEYS.map((key) => [key, resolveModelProfile(key).similarity]),
    );
    expect(chosen).toEqual(CALIBRATED_SIMILARITY);
  });
});
