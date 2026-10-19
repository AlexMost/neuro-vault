import { createVaultEntryServices } from '../../../daemon/services/vault-entry-services.js';
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
  createAttachment,
  createDaemonVaultClient,
  createInProcessLink,
  createLinkedVaultClient,
  type IInProcessLink,
  type IVaultAttachment,
  type IVaultClient,
} from '../vault-client/index.js';
import { createSemanticBackendView } from './view.js';

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
   * Closes the in-process loopback, then disposes the in-process vault entries,
   * if any vault ever needed them. Final: a backend that needs them afterwards
   * reads `unavailable` and fails its reads, and a lexical reader fails its searches.
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

/** One vault root on one side: its attachment, and the client over it. */
interface IVaultSide {
  attachment: IVaultAttachment;
  client: IVaultClient;
}

/**
 * The process's vault-side clients (design D8): every vault's semantic backend
 * and lexical reader, over one {@link IVaultClient} per vault root and side.
 * Under `--shared` a vault's client is the daemon client; under `--no-shared`,
 * or once the daemon could not be located or started, it is the in-process
 * client — the same core over a loopback that calls the daemon's own
 * `vault`/`corpus`/`lexical` handlers on this process's {@link VaultEntries}.
 * The one loopback and the entries under it are built on first use, so a
 * session the daemon serves never builds a watcher, a reconcile loop or a
 * corpus of its own.
 *
 * Each vault root has one attachment per side, built on the first factory call
 * for that root and shared by the vault's client and, until PR 2, its legacy
 * lexical reader: the first of them to ask makes the one attach, so a vault
 * still sends one `vault.attach` per epoch. It names the session's profile for
 * a vault that takes part in semantic search and none for one that opted out
 * with `"semantic": false`, which still attaches for its lexical leg. The
 * registry passes the same `enabled` to both factory calls of a vault; were
 * they ever to disagree, the first call's would win. The loopback attaches
 * under {@link LOCAL_CONNECTION_ID}, the id the legacy in-process lexical
 * reader reads the entry under.
 *
 * The entries index with the session's own embedder, for the session's one
 * profile; nothing in the process attaches another. They never idle out —
 * the session's clients hold them for its whole life — and `dispose()`
 * closes the loopback (which detaches it from every entry), then closes the
 * entries' watchers and stops the pass in flight, so nothing they started
 * outlives the client (design D10).
 */
export function createVaultClients(opts: IVaultClientsOptions): IVaultClients {
  const createEntries = opts.createEntries ?? ((deps) => new VaultEntries(deps));
  let entries: VaultEntries | undefined;
  let loopback: IInProcessLink | undefined;
  let disposed = false;
  /** One attachment and client per vault root and side, shared by the vault's readers. */
  const daemonSides = new Map<string, IVaultSide>();
  const localSides = new Map<string, IVaultSide>();

  /** Refuses once disposed: a call in flight at shutdown must not build what nothing disposes. */
  function refuseIfDisposed(): void {
    if (disposed) throw new Error('vault clients disposed: the session is shutting down');
  }

  function localEntries(): VaultEntries {
    // A call still in flight at shutdown (a daemon client whose switch flipped
    // after teardown, say) must not start watchers and a pass nothing disposes.
    refuseIfDisposed();
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

  /** The one loopback over this process's entries, under the legacy local reader's id (PR 1). */
  function inProcessLink(): IInProcessLink {
    refuseIfDisposed();
    loopback ??= createInProcessLink(createVaultEntryServices(localEntries()), {
      clientId: LOCAL_CONNECTION_ID,
    });
    return loopback;
  }

  const profilesFor = (enabled: boolean): string[] => (enabled ? [opts.profile] : []);

  function localSide(vaultRoot: string, enabled: boolean): IVaultSide {
    refuseIfDisposed();
    let side = localSides.get(vaultRoot);
    if (side === undefined) {
      const link = inProcessLink();
      const attachment = createAttachment({ link, vaultRoot, profiles: profilesFor(enabled) });
      side = { attachment, client: createLinkedVaultClient({ link, attachment }) };
      localSides.set(vaultRoot, side);
    }
    return side;
  }

  function daemonSide(vaultRoot: string, enabled: boolean): IVaultSide {
    let side = daemonSides.get(vaultRoot);
    if (side === undefined) {
      const attachment = createAttachment({
        link: opts.services.connection,
        vaultRoot,
        profiles: profilesFor(enabled),
      });
      const client = createDaemonVaultClient({
        services: opts.services,
        attachment,
        local: () => localSide(vaultRoot, enabled).client,
      });
      side = { attachment, client };
      daemonSides.set(vaultRoot, side);
    }
    return side;
  }

  function localReader(vaultRoot: string, enabled: boolean): ILexicalReader {
    return createLocalLexicalReader({
      entries: localEntries(),
      connectionId: LOCAL_CONNECTION_ID,
      attachment: localSide(vaultRoot, enabled).attachment,
    });
  }

  return {
    semanticBackendFactory: ({ vaultRoot, enabled }) => {
      // An opted-out vault's backend never attaches; its lexical reader does.
      if (!enabled) return createDisabledSemanticBackend();
      const side = opts.shared ? daemonSide(vaultRoot, true) : localSide(vaultRoot, true);
      return createSemanticBackendView(side.client, opts.profile);
    },
    lexicalReaderFactory: ({ vaultRoot, enabled }) => {
      if (!opts.shared) return localReader(vaultRoot, enabled);
      return createDaemonLexicalReader({
        services: opts.services,
        attachment: daemonSide(vaultRoot, enabled).attachment,
        local: () => localReader(vaultRoot, enabled),
      });
    },
    dispose: async () => {
      disposed = true;
      try {
        loopback?.close();
      } finally {
        await entries?.dispose();
      }
    },
  };
}
