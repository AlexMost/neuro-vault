import { buildReconcileFsDeps } from '../../../lib/obsidian/corpus/fs-deps.js';
import { reconcileCorpus } from '../../../lib/obsidian/corpus/reconcile.js';
import { CorpusStore } from '../../../lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../../../lib/obsidian/corpus/snapshot.js';
import type { SemanticBackend } from '../../../lib/obsidian/semantic-backend.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultScope } from '../../../lib/obsidian/vault-scope.js';
import type { QueuedEmbedder } from '../embed-queue.js';
import {
  createCorpusBackend,
  type CorpusBackend,
  type CorpusBackendDeps,
} from './corpus-backend.js';
import { startVaultWatcher, type WatcherFactory } from './vault-watcher.js';

export interface OwnCorpusBackendFactoryDeps {
  /** Shared process-wide (design D7) — one model, one embed in flight. */
  embedder: QueuedEmbedder;
  /** Injected by tests; production defaults to the chokidar-backed one. */
  createWatcher?: WatcherFactory;
  /**
   * Injected by tests; production defaults to {@link createCorpusBackend}.
   * Whether this factory disposes the backend it built — and in what order
   * relative to the watcher — is otherwise unobservable from the outside, since
   * `SemanticBackend` exposes nothing that changes once disposed.
   */
  createBackend?: (deps: CorpusBackendDeps) => CorpusBackend;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

export interface OwnCorpusBackendOptions {
  vaultRoot: string;
  vaultName: string;
  reader: VaultReader;
  /**
   * The vault's discovery scope. Applied to every decoded snapshot, so a note
   * excluded after the corpus was written is never rankable — the corpus only
   * catches up when a reconcile sweeps it, and until then the semantic leg
   * would otherwise expose what the lexical leg (which reads through the
   * scoped reader) already hides.
   */
  scope: VaultScope;
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

  const createBackend = deps.createBackend ?? createCorpusBackend;

  return ({ vaultRoot, vaultName, reader, scope, enabled }): SemanticBackend => {
    const store = new CorpusStore(vaultRoot, { warn });
    const fsDeps = buildReconcileFsDeps({ vaultRoot, reader });
    const embed = deps.embedder.asIndexEmbedFn();

    const backend = createBackend({
      vaultRoot,
      vaultName,
      enabled,
      store,
      loadSnapshot: (s, opts) =>
        loadCorpusSnapshot(s, {
          shards: opts?.shards,
          isExcluded: (relPath) => scope.isExcluded(relPath),
        }),
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
        // `finally`, not a plain sequence: a `watcher.close()` that rejects
        // (chokidar can) must not leave the corpus backend un-disposed. The
        // rejection still propagates — the server's disposer settles each
        // vault independently and reports it — but both halves have run by
        // then.
        try {
          await watcher?.close();
        } finally {
          await backend.dispose();
        }
      },
    };
  };
}
