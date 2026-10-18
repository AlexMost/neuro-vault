import {
  CorpusNotReadyError,
  type BackendStatus,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';
import { VaultEntries, type IVaultEntriesDeps } from '../../../lib/vault-entry/index.js';
import type { IRegisteredVaultDeps } from '../../../lib/vault-registry.js';
import type { ILexicalReader } from '../../../lib/obsidian/lexical/index.js';
import type { QueuedEmbedder } from '../embed-queue.js';
import { createDaemonLexicalReader, createLocalLexicalReader } from '../lexical/index.js';
import type { ISharedServices } from '../shared-services.js';
import {
  createDaemonAttachment,
  createLocalAttachment,
  type IVaultAttachment,
} from './attachment.js';
import { createDaemonSemanticBackend } from './daemon-backend.js';
import { createLocalSemanticBackend } from './local-backend.js';

export { createDaemonSemanticBackend } from './daemon-backend.js';
export { createLocalSemanticBackend } from './local-backend.js';

/** The one connection id this process attaches its in-process vault entries under. */
export const LOCAL_CONNECTION_ID = 0;

export interface IVaultClientsOptions {
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

export interface IVaultClients {
  /** The registry's `semanticBackendFactory`: one vault in, its backend out. */
  semanticBackendFactory: IRegisteredVaultDeps['semanticBackendFactory'];
  /** The registry's `lexicalReaderFactory`: one vault in, its lexical reader out. */
  lexicalReaderFactory: IRegisteredVaultDeps['lexicalReaderFactory'];
  /**
   * Disposes the in-process vault entries, if any vault ever needed them. Final:
   * a backend that needs them afterwards reads `unavailable` and fails its reads,
   * and a lexical reader fails its searches.
   */
  dispose(): Promise<void>;
}

/**
 * The backend of a vault whose config sets `"semantic": false`: it never
 * attaches by itself. The vault's lexical reader attaches it with no profile,
 * so neither the daemon nor this process indexes it.
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
 * The process's vault-side clients (design D8): every vault's semantic backend
 * and lexical reader, and the one in-process {@link VaultEntries} the local
 * ones share (design D11, D12). Under `--shared` a vault's clients are the
 * daemon facades; under `--no-shared`, or once the daemon could not be located
 * or started, they read the vault entry run in this process. The entries are
 * built on first use, so a session the daemon serves never builds a watcher, a
 * reconcile loop or a corpus of its own.
 *
 * Each vault root has one attachment per side (design D7), built on the first
 * factory call for that root and shared by the vault's backend and reader:
 * the first of them to ask makes the one attach. It names the session's
 * profile for a vault that takes part in semantic search and none for one
 * that opted out with `"semantic": false`, which still attaches for its
 * lexical leg. The registry passes the same `enabled` to both factory calls
 * of a vault; were they ever to disagree, the first call's would win.
 *
 * The entries index with the session's own embedder, for the session's one
 * profile; nothing in the process attaches another. They never idle out —
 * the session's clients hold them for its whole life — and `dispose()`
 * closes their watchers and stops the pass in flight, so nothing they started
 * outlives the client (design D10).
 */
export function createVaultClients(opts: IVaultClientsOptions): IVaultClients {
  const createEntries = opts.createEntries ?? ((deps) => new VaultEntries(deps));
  let entries: VaultEntries | undefined;
  let disposed = false;
  /** One attachment per vault root and side: the backend and the reader of a vault share it. */
  const daemonAttachments = new Map<string, IVaultAttachment>();
  const localAttachments = new Map<string, IVaultAttachment>();

  function localEntries(): VaultEntries {
    // A call still in flight at shutdown (a daemon facade whose switch flipped
    // after teardown, say) must not start watchers and a pass nothing disposes.
    if (disposed) throw new Error('vault clients disposed: the session is shutting down');
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

  const profilesFor = (enabled: boolean): string[] => (enabled ? [opts.profile] : []);

  function localAttachment(vaultRoot: string, enabled: boolean): IVaultAttachment {
    let attachment = localAttachments.get(vaultRoot);
    if (attachment === undefined) {
      attachment = createLocalAttachment({
        entries: localEntries(),
        connectionId: LOCAL_CONNECTION_ID,
        vaultRoot,
        profiles: profilesFor(enabled),
      });
      localAttachments.set(vaultRoot, attachment);
    }
    return attachment;
  }

  function daemonAttachment(vaultRoot: string, enabled: boolean): IVaultAttachment {
    let attachment = daemonAttachments.get(vaultRoot);
    if (attachment === undefined) {
      attachment = createDaemonAttachment({
        services: opts.services,
        vaultRoot,
        profiles: profilesFor(enabled),
      });
      daemonAttachments.set(vaultRoot, attachment);
    }
    return attachment;
  }

  function localBackend(vaultRoot: string): ISemanticBackend {
    return createLocalSemanticBackend({
      entries: localEntries(),
      connectionId: LOCAL_CONNECTION_ID,
      attachment: localAttachment(vaultRoot, true),
      profile: opts.profile,
    });
  }

  function localReader(vaultRoot: string, enabled: boolean): ILexicalReader {
    return createLocalLexicalReader({
      entries: localEntries(),
      connectionId: LOCAL_CONNECTION_ID,
      attachment: localAttachment(vaultRoot, enabled),
    });
  }

  return {
    semanticBackendFactory: ({ vaultRoot, enabled }) => {
      // An opted-out vault's backend never attaches; its lexical reader does.
      if (!enabled) return createDisabledSemanticBackend();
      if (!opts.shared) return localBackend(vaultRoot);
      return createDaemonSemanticBackend({
        services: opts.services,
        attachment: daemonAttachment(vaultRoot, true),
        profile: opts.profile,
        local: () => localBackend(vaultRoot),
      });
    },
    lexicalReaderFactory: ({ vaultRoot, enabled }) => {
      if (!opts.shared) return localReader(vaultRoot, enabled);
      return createDaemonLexicalReader({
        services: opts.services,
        attachment: daemonAttachment(vaultRoot, enabled),
        local: () => localReader(vaultRoot, enabled),
      });
    },
    dispose: async () => {
      disposed = true;
      await entries?.dispose();
    },
  };
}
