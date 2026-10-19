import {
  DaemonRpcError,
  type VaultCallParams,
  type VaultCallResult,
  type VaultMethod,
} from '../../../daemon/protocol.js';
import type { BackendStatus } from '../../../lib/obsidian/semantic-backend.js';
import { isStatus } from '../backend/corpus-wire.js';
import { DaemonTimeoutError } from '../daemon-connection.js';
import type { IVaultAttachment } from './attachment.js';
import type { IVaultLink } from './link.js';
import { timeoutOf } from './timeouts.js';

/**
 * One vault root on one side — the daemon's socket or the in-process loopback (design D5).
 * The views (semantic backend, lexical reader) hold one and never ask which side serves it.
 */
export interface IVaultClient {
  /** One read of the vault entry, under the key this side attached; attaches first when needed. */
  call<M extends VaultMethod>(method: M, params: VaultCallParams<M>): Promise<VaultCallResult<M>>;
  /** `profile`'s status. Never rejects: a failure reads `unavailable` for this call only. */
  status(profile: string): Promise<BackendStatus>;
  /** Attach now; never rejects (a head start: the next call meets any failure again). */
  warm(): Promise<void>;
  /** Releases what this client built on its own; the connection and the entries are the process's. */
  dispose(): Promise<void>;
}

/** What a vault reads until its first attach answers (spec: sessions attach in the background). */
export const ATTACHING: BackendStatus = { state: 'indexing', indexed: 0, total: 0 };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The reason a status could not be read: one call's answer, never a lasting state. */
export function unreadable(error: unknown): BackendStatus {
  if (error instanceof DaemonTimeoutError) {
    return { state: 'unavailable', reason: 'daemon did not answer' };
  }
  return { state: 'unavailable', reason: messageOf(error) };
}

/** The daemon no longer knows the vault on this connection: the next call attaches again. */
function forgetIfNotAttached(attachment: IVaultAttachment, error: unknown): void {
  if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') attachment.forget();
}

/**
 * The client over one link: the daemon's socket connection, or the in-process loopback — the
 * in-process client is this core over the loopback, with nothing left to adapt.
 *
 * Every call carries the realpath key the attachment answered with on the current epoch, and
 * waits as long as {@link timeoutOf} gives its method. While an attach is in flight the vault
 * reads `indexing` 0/0. A first status that finds the vault unattached makes (or joins) the
 * attach and reads that answer's status for the profile; once attached it asks `vault.status`,
 * so another reader's earlier attach never leaves it reading a stale answer. A status that
 * cannot be read — a timeout ("daemon did not answer"), a dropped connection, a vault the
 * entry cannot attach (`VAULT_UNAVAILABLE`) — reads `unavailable` for that call only; the
 * next call attaches again.
 *
 * Every failure of a call rejects as itself (the views map them to their own vocabulary);
 * a `NOT_ATTACHED` also forgets the attach, so the next call makes a new one.
 */
export function createLinkedVaultClient(opts: {
  link: IVaultLink;
  attachment: IVaultAttachment;
}): IVaultClient {
  const { link, attachment } = opts;

  return {
    async call<M extends VaultMethod>(
      method: M,
      params: VaultCallParams<M>,
    ): Promise<VaultCallResult<M>> {
      const vault = await attachment.key();
      try {
        return await link.request<VaultCallResult<M>>(
          method,
          { ...params, vault },
          timeoutOf(method),
        );
      } catch (error) {
        forgetIfNotAttached(attachment, error);
        throw error;
      }
    },

    async status(profile) {
      try {
        if (attachment.attaching) return ATTACHING;
        if (!attachment.attached) {
          // This call starts the attach or joins it: it reads the attach's own answer.
          await attachment.key();
          // Defensive: key() re-attaches on the current epoch, so this only guards a race in the
          // microtask gap.
          if (!attachment.attached) return ATTACHING;
          return (
            attachment.statusOf(profile) ?? {
              state: 'unavailable',
              reason: `daemon answered vault.attach without "${profile}"`,
            }
          );
        }
        const status = await link.request<unknown>(
          'vault.status',
          { vault: await attachment.key(), profile },
          timeoutOf('vault.status'),
        );
        if (!isStatus(status)) throw new Error('daemon answered vault.status without a state');
        return status;
      } catch (error) {
        forgetIfNotAttached(attachment, error);
        return unreadable(error);
      }
    },

    async warm() {
      try {
        await attachment.key();
      } catch {
        // A head start only: the next call meets the failure again, and reports it.
      }
    },

    // The link and the entries are the process's; this client built nothing of its own.
    dispose: () => Promise.resolve(),
  };
}
