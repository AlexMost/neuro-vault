import { describe, expect, it, vi } from 'vitest';

import { EmbeddingService } from '../../src/modules/semantic/embedding-service.js';
import type { LocalModelLoader } from '../../src/modules/semantic/local-model-loader.js';
import {
  DEFAULT_MODEL_KEY,
  resolveModelProfile,
} from '../../src/modules/semantic/model-profiles.js';
import { createEmbeddingProvider } from '../../src/modules/semantic/provider-factory.js';

describe('createEmbeddingProvider', () => {
  const profile = resolveModelProfile(DEFAULT_MODEL_KEY);

  it('returns the in-process provider when not shared', () => {
    // Construction loads nothing: the default loader is only a closure until initialize().
    const provider = createEmbeddingProvider({ profile, shared: false });
    expect(provider).toBeInstanceOf(EmbeddingService);
    expect(provider.identity.model_key).toBe(profile.key);
  });

  it('passes an injected loader through to the in-process provider', async () => {
    const loadFailure = new Error('fake loader reached');
    const loader = vi.fn<LocalModelLoader>().mockRejectedValue(loadFailure);
    const provider = createEmbeddingProvider({ profile, shared: false, loader });

    await expect(provider.initialize()).rejects.toBe(loadFailure);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(profile);
  });

  it('throws for a shared provider until the daemon-backed half lands', () => {
    expect(() => createEmbeddingProvider({ profile, shared: true })).toThrow(
      /shared.*not implemented/,
    );
  });
});
