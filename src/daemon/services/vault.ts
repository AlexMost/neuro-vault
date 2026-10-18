import path from 'node:path';

import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  asRecord,
  DaemonRpcError,
  onlyKeys,
  stringParam,
  type IConnectionContext,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

function profilesParam(params: Record<string, unknown>): string[] {
  const value = params.profiles;
  if (!Array.isArray(value) || !value.every((p): p is string => typeof p === 'string')) {
    throw new DaemonRpcError('INVALID_PARAMS', 'profiles must be an array of strings');
  }
  return value;
}

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
    attach: async (params, ctx) => {
      const record = asRecord(params);
      // No scope, no exclusions, no corpus identity: the daemon reads those from the vault (spec).
      onlyKeys(record, ['vault', 'profiles']);
      const vault = stringParam(record, 'vault');
      // A malformed param, not an unavailable vault: the daemon has no cwd to resolve it against.
      if (!path.isAbsolute(vault)) {
        throw new DaemonRpcError('INVALID_PARAMS', 'vault must be an absolute path');
      }
      const profiles = profilesParam(record);
      // Hooked before the await: a connection closing mid-attach must still detach.
      detachOnClose(ctx);
      return wired(() => entries.attach(ctx.id, vault, profiles));
    },
    status: async (params, ctx) => {
      const record = asRecord(params);
      onlyKeys(record, ['vault', 'profile']);
      const vault = stringParam(record, 'vault');
      const profile = stringParam(record, 'profile');
      return wired(() => entries.status(ctx.id, vault, profile));
    },
  };
}
