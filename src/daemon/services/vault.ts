import { VaultEntryError, type VaultEntries } from '../../lib/vault-entry/index.js';
import {
  asRecord,
  DaemonRpcError,
  type ConnectionContext,
  type ServiceHandlers,
} from '../protocol.js';

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') {
    throw new DaemonRpcError('INVALID_PARAMS', `${name} must be a string`);
  }
  return value;
}

function profilesParam(params: Record<string, unknown>): string[] {
  const value = params.profiles;
  if (!Array.isArray(value) || !value.every((p): p is string => typeof p === 'string')) {
    throw new DaemonRpcError('INVALID_PARAMS', 'profiles must be an array of strings');
  }
  return value;
}

/** A `VaultEntryError` keeps its code and message on the wire; anything else is the registry's INTERNAL. */
async function wired<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof VaultEntryError) throw new DaemonRpcError(error.code, error.message);
    throw error;
  }
}

/**
 * `vault.attach` and `vault.status` over the daemon's vault entries (design D7).
 * There is no `vault.detach`: a closing connection detaches itself, so a client
 * that dies cannot leave an entry pinned. Attach answers from path checks and
 * two small config files only (the entries start every load and pass in the
 * background), so it needs no deadline of its own.
 */
export function createVaultService(entries: VaultEntries): ServiceHandlers {
  // Connections whose close is already hooked; each removes itself when it closes.
  const hooked = new Set<number>();

  function detachOnClose(ctx: ConnectionContext): void {
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
      const vault = stringParam(record, 'vault');
      const profiles = profilesParam(record);
      // Hooked before the await: a connection closing mid-attach must still detach.
      detachOnClose(ctx);
      return wired(() => entries.attach(ctx.id, vault, profiles));
    },
    status: async (params, ctx) => {
      const record = asRecord(params);
      const vault = stringParam(record, 'vault');
      const profile = stringParam(record, 'profile');
      return wired(() => entries.status(ctx.id, vault, profile));
    },
  };
}
