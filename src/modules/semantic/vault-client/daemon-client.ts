import { SharedServicesClosedError, type ISharedServices } from '../shared-services.js';
import type { IVaultAttachment } from './attachment.js';
import { ATTACHING, createLinkedVaultClient, unreadable, type IVaultClient } from './client.js';

export interface IDaemonVaultClientOptions {
  /** The process's connection and one-way switch, shared with every other daemon facade. */
  services: ISharedServices;
  /** The vault's attachment over `services.connection`, shared with every other reader of it. */
  attachment: IVaultAttachment;
  /** The vault's in-process client, built once, on the first call after the switch went `local`. */
  local: () => IVaultClient;
}

/**
 * The client over the shared daemon (design D6): the core over `services.connection`, and the
 * one place per vault the process's one-way switch is consulted. Once `services.ensure()`
 * answers `local` — the daemon could not be located or started — every call goes to the
 * in-process client instead, built once.
 *
 * While the switch is still undecided (`services.mode` is `pending`, the daemon being located
 * or started), a status does not wait for the connect, which may take the whole
 * spawn-and-poll: it reads `indexing` 0/0 and starts the connect-then-attach (or the
 * in-process attach, if the switch goes `local`) in the background. Once decided, a status
 * waits for a reconnect and reads through the decided side; a connect that fails reads
 * `unavailable` for that call. A dropped connection never flips the switch: the next call
 * reconnects through `services`.
 */
export function createDaemonVaultClient(opts: IDaemonVaultClientOptions): IVaultClient {
  const { services, attachment } = opts;
  const core = createLinkedVaultClient({ link: services.connection, attachment });
  let local: IVaultClient | undefined;
  /** The background connect-then-attach a status started while the switch was undecided. */
  let starting: Promise<void> | undefined;
  /** Set when a background connect met the closed services: the session is gone. */
  let closed: SharedServicesClosedError | undefined;

  /** The side that serves this vault: connects (or decides `local`) first. */
  async function side(): Promise<IVaultClient> {
    if ((await services.ensure()) === 'daemon') return core;
    local ??= opts.local();
    return local;
  }

  /**
   * Connect, then attach, in the background. Concurrent statuses share it, and it never
   * rejects. A connect that cannot be made flips the switch, and a failed attach leaves it
   * decided: either way the next status reads through the decided side. The one failure that
   * leaves the switch undecided is the services closing under the connect; it is remembered,
   * so a later status reads `unavailable` with its reason.
   */
  function startInBackground(): void {
    starting ??= (async () => {
      try {
        await (await side()).warm();
      } catch (error) {
        if (error instanceof SharedServicesClosedError) closed = error;
      } finally {
        starting = undefined;
      }
    })();
  }

  return {
    async call(method, params) {
      return (await side()).call(method, params);
    },

    async status(profile) {
      if (services.mode === 'pending') {
        if (closed) return unreadable(closed);
        startInBackground();
        return ATTACHING;
      }
      let decided: IVaultClient;
      try {
        decided = await side();
      } catch (error) {
        return unreadable(error);
      }
      return decided.status(profile);
    },

    async warm() {
      try {
        await (await side()).warm();
      } catch {
        // A head start only: the next call meets the failure again, and reports it.
      }
    },

    async dispose() {
      // The connection is the process's; closing it (which detaches every vault) is the server's.
      await local?.dispose();
    },
  };
}
