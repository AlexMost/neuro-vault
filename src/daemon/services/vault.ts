import type { BackendStatus } from '../../lib/obsidian/semantic-backend.js';
import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  defineMethod,
  vaultAttachParams,
  vaultStatusParams,
  type IConnectionContext,
  type ServiceHandlers,
  type VaultAttachResult,
} from '../protocol.js';
import { wired } from './wired.js';

/**
 * `vault.attach` and `vault.status` over the daemon's vault entries (design D7).
 * There is no `vault.detach`: a closing connection detaches itself, so a client
 * that dies cannot leave an entry pinned. Attach answers from path checks and
 * two small config files only (the entries start every load and pass in the
 * background), so it needs no deadline of its own.
 */
/** The slice of the registry the service uses. */
export type VaultEntriesPort = Pick<VaultEntries, 'attach' | 'status' | 'detach'>;

export function createVaultService(entries: VaultEntriesPort): ServiceHandlers {
  // Connections whose close is already hooked; each removes itself when it closes.
  const hooked = new Set<number>();

  function detachOnClose(ctx: IConnectionContext): void {
    if (hooked.has(ctx.id)) return;
    hooked.add(ctx.id);
    ctx.onClose(() => {
      hooked.delete(ctx.id);
      entries.detach(ctx.id);
    });
  }

  return {
    attach: defineMethod({
      params: vaultAttachParams,
      handler: async ({ vault, profiles }, ctx): Promise<VaultAttachResult> => {
        // Hooked before the await: a connection closing mid-attach must still detach.
        detachOnClose(ctx);
        return wired(() => entries.attach(ctx.id, vault, profiles));
      },
    }),
    status: defineMethod({
      params: vaultStatusParams,
      handler: async ({ vault, profile }, ctx): Promise<BackendStatus> =>
        wired(() => entries.status(ctx.id, vault, profile)),
    }),
  };
}
