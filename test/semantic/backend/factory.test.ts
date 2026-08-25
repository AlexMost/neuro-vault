import { describe, expect, it, vi } from 'vitest';

import { createOwnCorpusBackendFactory } from '../../../src/modules/semantic/backend/index.js';

describe('createOwnCorpusBackendFactory', () => {
  it('does not start a watcher for a disabled vault', () => {
    const createWatcher = vi.fn();
    const factory = createOwnCorpusBackendFactory({
      embedder: { asIndexEmbedFn: () => async () => [1] } as never,
      createWatcher,
    });
    const backend = factory({
      vaultRoot: '/v',
      vaultName: 'v',
      reader: { scan: async () => [] } as never,
      enabled: false,
    });
    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(createWatcher).not.toHaveBeenCalled();
  });

  it('closes the watcher on dispose', async () => {
    const close = vi.fn(async () => {});
    const factory = createOwnCorpusBackendFactory({
      embedder: { asIndexEmbedFn: () => async () => [1] } as never,
      createWatcher: () => ({ close }),
    });
    const backend = factory({
      vaultRoot: '/v',
      vaultName: 'v',
      reader: { scan: async () => [] } as never,
      enabled: true,
    });
    await backend.dispose();
    expect(close).toHaveBeenCalled();
  });
});
