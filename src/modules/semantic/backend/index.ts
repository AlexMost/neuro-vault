import {
  CorpusNotReadyError,
  type BackendStatus,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';
import { VaultEntries, type IVaultEntriesDeps } from '../../../lib/vault-entry/index.js';
import type { QueuedEmbedder } from '../embed-queue.js';
import type { ISharedServices } from '../shared-services.js';
import { createDaemonSemanticBackend } from './daemon-backend.js';
import { createLocalSemanticBackend } from './local-backend.js';

export { createDaemonSemanticBackend } from './daemon-backend.js';
export { createLocalSemanticBackend } from './local-backend.js';

/** The one connection id this process attaches its in-process vault entries under. */
export const LOCAL_CONNECTION_ID = 0;

export interface ISemanticBackendsOptions {
  /** The process's connection and one-way switch. */
  services: ISharedServices;
  /** `--shared` (default): the daemon serves the corpus; `--no-shared`: this process does. */
  shared: boolean;
  /** The one model profile this process serves. */
  profile: string;
  /** Shared process-wide (design D7): the in-process entries index through it. */
  embedder: QueuedEmbedder;
  /** Injected by tests; production builds a {@link VaultEntries}. */
  createEntries?: (deps: IVaultEntriesDeps) => VaultEntries;
}

export interface ISemanticBackendOptions {
  vaultRoot: string;
  /** Global `--semantic` AND the per-vault `semantic` key, already resolved. */
  enabled: boolean;
}

export interface ISemanticBackends {
  /** The registry's `semanticBackendFactory`: one vault in, its backend out. */
  factory: (opts: ISemanticBackendOptions) => ISemanticBackend;
  /**
   * Disposes the in-process vault entries, if any vault ever needed them. Final:
   * a backend that needs them afterwards reads `unavailable` and fails its reads.
   */
  dispose(): Promise<void>;
}

/**
 * The backend of a vault whose config sets `"semantic": false`: it never
 * attaches, so neither the daemon nor this process watches or indexes it.
 */
export function createDisabledSemanticBackend(): ISemanticBackend {
  const status: BackendStatus = { state: 'disabled' };
  const refuse = (): Promise<never> => Promise.reject(new CorpusNotReadyError(status));
  return {
    status: () => Promise.resolve(status),
    nearest: refuse,
    nearestBlocks: refuse,
    dispose: () => Promise.resolve(),
  };
}

/**
 * Every vault's semantic backend, and the one in-process {@link VaultEntries}
 * the local ones share (design D11, D12). Under `--shared` a vault's backend
 * is the daemon facade; under `--no-shared`, or once the daemon could not be
 * located or started, it is the vault entry run in this process. The entries
 * are built on first use, so a session the daemon serves never builds a
 * watcher, a reconcile loop or a corpus of its own.
 *
 * The entries index with the session's own embedder, for the session's one
 * profile; nothing in the process attaches another. They never idle out —
 * the session's backends hold them for its whole life — and `dispose()`
 * closes their watchers and stops the pass in flight, so nothing they started
 * outlives the client (design D10).
 */
export function createSemanticBackends(opts: ISemanticBackendsOptions): ISemanticBackends {
  const createEntries = opts.createEntries ?? ((deps) => new VaultEntries(deps));
  let entries: VaultEntries | undefined;
  let disposed = false;

  function localEntries(): VaultEntries {
    // A call still in flight at shutdown (a daemon facade whose switch flipped
    // after teardown, say) must not start watchers and a pass nothing disposes.
    if (disposed) throw new Error('semantic backends disposed: the session is shutting down');
    entries ??= createEntries({
      embedderFor: (key) => {
        if (key !== opts.profile) {
          throw new Error(`this session embeds "${opts.profile}" only, not "${key}"`);
        }
        return opts.embedder.asDocumentEmbedFn();
      },
      idleTimeoutMs: 0,
    });
    return entries;
  }

  function localBackend(vaultRoot: string): ISemanticBackend {
    return createLocalSemanticBackend({
      entries: localEntries(),
      connectionId: LOCAL_CONNECTION_ID,
      vaultRoot,
      profile: opts.profile,
    });
  }

  return {
    factory: ({ vaultRoot, enabled }) => {
      if (!enabled) return createDisabledSemanticBackend();
      if (!opts.shared) return localBackend(vaultRoot);
      return createDaemonSemanticBackend({
        services: opts.services,
        vaultRoot,
        profile: opts.profile,
        local: () => localBackend(vaultRoot),
      });
    },
    dispose: async () => {
      disposed = true;
      await entries?.dispose();
    },
  };
}
