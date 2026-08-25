import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorpusBackend } from '../../../src/modules/semantic/backend/corpus-backend.js';
import { createOwnCorpusBackendFactory } from '../../../src/modules/semantic/backend/index.js';

const embedder = { asIndexEmbedFn: () => async () => [1] } as never;
const reader = { scan: async () => [] } as never;

/**
 * A stand-in for the corpus backend this factory builds. Whether the factory
 * disposes it — and in what order relative to the watcher — is otherwise
 * unobservable: `SemanticBackend` exposes nothing that changes once disposed.
 * `order` is appended to by both this and the fake watcher, so the sequence is
 * observed rather than assumed.
 */
function fakeBackend(order: string[]): CorpusBackend {
  return {
    snapshot: async () => {
      throw new Error('snapshot not used in these tests');
    },
    status: () => ({ state: 'ready' }),
    dispose: vi.fn(async () => {
      order.push('backend.dispose');
    }),
    whenSettled: async () => {},
    requestReconcile: () => {},
  };
}

describe('createOwnCorpusBackendFactory', () => {
  // A real directory, because an `enabled: true` backend starts its own
  // unawaited pass against the vault root. Pointing it at a temp dir keeps
  // these tests off `/` and off any race with a filesystem they do not own.
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-factory-'));
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('does not start a watcher for a disabled vault', () => {
    const createWatcher = vi.fn();
    const factory = createOwnCorpusBackendFactory({ embedder, createWatcher });

    const backend = factory({ vaultRoot, vaultName: 'v', reader, enabled: false });

    expect(backend.status()).toEqual({ state: 'disabled' });
    expect(createWatcher).not.toHaveBeenCalled();
  });

  it('closes the watcher and then disposes the corpus backend', async () => {
    const order: string[] = [];
    const inner = fakeBackend(order);
    const factory = createOwnCorpusBackendFactory({
      embedder,
      createBackend: () => inner,
      createWatcher: () => ({
        close: vi.fn(async () => {
          order.push('watcher.close');
        }),
      }),
    });

    const backend = factory({ vaultRoot, vaultName: 'v', reader, enabled: true });
    await backend.dispose();

    // Watcher first: it is what feeds `requestReconcile`, so closing it after
    // the backend would leave a window where a quiet-period fires into a
    // backend that has already released its resources.
    expect(order).toEqual(['watcher.close', 'backend.dispose']);
  });

  it('still disposes the corpus backend when the watcher fails to close', async () => {
    const order: string[] = [];
    const inner = fakeBackend(order);
    const factory = createOwnCorpusBackendFactory({
      embedder,
      createBackend: () => inner,
      createWatcher: () => ({
        close: async () => {
          order.push('watcher.close');
          throw new Error('chokidar close failed');
        },
      }),
    });

    const backend = factory({ vaultRoot, vaultName: 'v', reader, enabled: true });

    // The failure still surfaces to the caller — the server's disposer settles
    // each vault independently and reports it — but not at the cost of leaking
    // the backend.
    await expect(backend.dispose()).rejects.toThrow('chokidar close failed');
    expect(order).toEqual(['watcher.close', 'backend.dispose']);
  });
});
