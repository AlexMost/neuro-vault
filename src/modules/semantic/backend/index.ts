import { buildReconcileFsDeps } from '../../../lib/obsidian/corpus/fs-deps.js';
import { reconcileCorpus } from '../../../lib/obsidian/corpus/reconcile.js';
import { CorpusStore } from '../../../lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../../../lib/obsidian/corpus/snapshot.js';
import type { SemanticBackend } from '../../../lib/obsidian/semantic-backend.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { QueuedEmbedder } from '../embed-queue.js';
import { createCorpusBackend } from './corpus-backend.js';
import { startVaultWatcher, type WatcherFactory } from './vault-watcher.js';

export interface OwnCorpusBackendFactoryDeps {
  /** Shared process-wide (design D7) — one model, one embed in flight. */
  embedder: QueuedEmbedder;
  /** Injected by tests; production defaults to the chokidar-backed one. */
  createWatcher?: WatcherFactory;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

export interface OwnCorpusBackendOptions {
  vaultRoot: string;
  vaultName: string;
  reader: VaultReader;
  /** Global `--semantic` AND the per-vault `semantic` key, already resolved. */
  enabled: boolean;
}

/**
 * The production `semanticBackendFactory`: one vault in, one live backend over
 * that vault's own corpus out (design D3).
 *
 * This is where the pieces meet — the corpus store under the vault, the
 * filesystem reconcile deps, the shared embed queue, the shard→snapshot decode,
 * and the debounced watcher that asks for another pass once the vault goes
 * quiet. Nothing here is awaited: the factory is synchronous by contract so
 * registry construction — and therefore startup — never waits on indexing.
 *
 * A disabled vault gets a backend that reports `disabled` and runs nothing, and
 * no watcher at all: `requestReconcile()` is inert on such a backend, so a
 * watcher would only burn file handles for a signal nobody acts on.
 *
 * `dispose()` closes the watcher first, then the backend. A live chokidar
 * watcher holds the event loop open, so skipping it would outlive the client
 * that started the server (design D10).
 */
export function createOwnCorpusBackendFactory(
  deps: OwnCorpusBackendFactoryDeps,
): (opts: OwnCorpusBackendOptions) => SemanticBackend {
  const warn = deps.warn ?? ((message: string) => console.error(message));

  return ({ vaultRoot, vaultName, reader, enabled }): SemanticBackend => {
    const store = new CorpusStore(vaultRoot);
    const fsDeps = buildReconcileFsDeps({ vaultRoot, reader });
    const embed = deps.embedder.asIndexEmbedFn();

    const backend = createCorpusBackend({
      vaultRoot,
      vaultName,
      enabled,
      store,
      loadSnapshot: loadCorpusSnapshot,
      reconcile: (opts) => reconcileCorpus({ ...fsDeps, embed, store, warn }, opts),
      warn,
    });

    const watcher = enabled
      ? startVaultWatcher({
          vaultRoot,
          vaultName,
          onQuiet: () => backend.requestReconcile(),
          createWatcher: deps.createWatcher,
          warn,
        })
      : undefined;

    return {
      snapshot: () => backend.snapshot(),
      status: () => backend.status(),
      dispose: async () => {
        await watcher?.close();
        await backend.dispose();
      },
    };
  };
}
