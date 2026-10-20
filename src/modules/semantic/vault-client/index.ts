import { createVaultEntryServices } from '../../../daemon/services/vault-entry-services.js';
import { VaultEntries, type IVaultEntriesDeps } from '../../../lib/vault-entry/index.js';
import type { IRegisteredVaultDeps } from '../../../lib/vault-registry.js';
import { createDisabledSemanticBackend } from '../backend/index.js';
import { createSemanticBackendView } from '../backend/view.js';
import type { QueuedEmbedder } from '../embed-queue.js';
import { createGraphReaderView } from '../graph/view.js';
import { createLexicalReaderView } from '../lexical/view.js';
import type { ISharedServices } from '../shared-services.js';
import { createAttachment } from './attachment.js';
import { createLinkedVaultClient, type IVaultClient } from './client.js';
import { createDaemonVaultClient } from './daemon-client.js';
import { createInProcessLink, type IInProcessLink } from './link.js';

export { createAttachment, type IAttachmentOptions, type IVaultAttachment } from './attachment.js';
export { ATTACHING, createLinkedVaultClient, type IVaultClient } from './client.js';
export { createDaemonVaultClient, type IDaemonVaultClientOptions } from './daemon-client.js';
export { createInProcessLink, type IInProcessLink, type IVaultLink } from './link.js';
export { timeoutOf, VAULT_CALL_TIMEOUTS } from './timeouts.js';

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
  /** The registry's `graphFactory`: one vault in, the view of its entry's graph out. */
  graphFactory: IRegisteredVaultDeps['graphFactory'];
  /**
   * Closes the in-process loopback, then disposes the in-process vault entries,
   * if any vault ever needed them. Final: a backend that needs them afterwards
   * reads `unavailable` and fails its reads, a lexical reader fails its searches,
   * and a graph reader fails its reads.
   */
  dispose(): Promise<void>;
}

/**
 * The process's vault-side clients (design D8): every vault's semantic backend,
 * lexical reader and graph reader are views over one {@link IVaultClient} per
 * vault root and side. Under `--shared` a vault's client is the daemon client; under
 * `--no-shared`, or once the daemon could not be located or started, it is the
 * in-process client — the same core over a loopback that calls the daemon's own
 * `vault`/`corpus`/`lexical`/`graph` handlers on this process's {@link VaultEntries}.
 * The one loopback and the entries under it are built on first use, so a
 * session the daemon serves never builds a watcher, a reconcile loop or a
 * corpus of its own.
 *
 * Each vault root has one client per side, built on the first factory call for
 * that root and shared by the vault's views: the first of them to ask makes
 * the one attach, so a vault sends one `vault.attach` per epoch. It names the
 * session's profile for a vault that takes part in semantic search and none for
 * one that opted out with `"semantic": false`, which still attaches for its
 * lexical leg and its graph. The registry passes the same `enabled` to every
 * factory call of a vault; were they ever to disagree, the first call's would win.
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
  /** One client per vault root and side, shared by the vault's views. */
  const daemonClients = new Map<string, IVaultClient>();
  const localClients = new Map<string, IVaultClient>();

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

  /** The one loopback over this process's entries: one client id for every vault. */
  function inProcessLink(): IInProcessLink {
    refuseIfDisposed();
    loopback ??= createInProcessLink(createVaultEntryServices(localEntries()));
    return loopback;
  }

  const profilesFor = (enabled: boolean): string[] => (enabled ? [opts.profile] : []);

  function localClient(vaultRoot: string, enabled: boolean): IVaultClient {
    refuseIfDisposed();
    let client = localClients.get(vaultRoot);
    if (client === undefined) {
      const link = inProcessLink();
      const attachment = createAttachment({ link, vaultRoot, profiles: profilesFor(enabled) });
      client = createLinkedVaultClient({ link, attachment });
      localClients.set(vaultRoot, client);
    }
    return client;
  }

  function daemonClient(vaultRoot: string, enabled: boolean): IVaultClient {
    let client = daemonClients.get(vaultRoot);
    if (client === undefined) {
      client = createDaemonVaultClient({
        services: opts.services,
        attachment: createAttachment({
          link: opts.services.connection,
          vaultRoot,
          profiles: profilesFor(enabled),
        }),
        local: () => localClient(vaultRoot, enabled),
      });
      daemonClients.set(vaultRoot, client);
    }
    return client;
  }

  const clientOf = (vaultRoot: string, enabled: boolean): IVaultClient =>
    opts.shared ? daemonClient(vaultRoot, enabled) : localClient(vaultRoot, enabled);

  return {
    semanticBackendFactory: ({ vaultRoot, enabled }) => {
      // An opted-out vault's backend never attaches; its lexical reader does.
      if (!enabled) return createDisabledSemanticBackend();
      return createSemanticBackendView(clientOf(vaultRoot, true), opts.profile);
    },
    lexicalReaderFactory: ({ vaultRoot, enabled }) =>
      createLexicalReaderView(clientOf(vaultRoot, enabled)),
    graphFactory: ({ vaultRoot, enabled }) => createGraphReaderView(clientOf(vaultRoot, enabled)),
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
