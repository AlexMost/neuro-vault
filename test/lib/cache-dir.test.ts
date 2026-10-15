import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { neuroVaultCacheBase } from '../../src/lib/cache-dir.js';

describe('neuroVaultCacheBase', () => {
  it('uses an absolute XDG_CACHE_HOME', () => {
    expect(neuroVaultCacheBase({ XDG_CACHE_HOME: '/x/cache' }, '/home/u')).toBe(
      '/x/cache/neuro-vault',
    );
  });
  it('ignores a relative XDG_CACHE_HOME', () => {
    expect(neuroVaultCacheBase({ XDG_CACHE_HOME: 'rel' }, '/home/u')).toBe(
      path.join('/home/u', '.cache', 'neuro-vault'),
    );
  });
  it('defaults to ~/.cache', () => {
    expect(neuroVaultCacheBase({}, '/home/u')).toBe(path.join('/home/u', '.cache', 'neuro-vault'));
  });
});
