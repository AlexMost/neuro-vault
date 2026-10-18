import { VaultEntryError } from '../../lib/vault-entry/index.js';
import { DaemonRpcError } from '../protocol.js';

/** A `VaultEntryError` keeps its code and message on the wire; anything else stays INTERNAL. */
export async function wired<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof VaultEntryError) throw new DaemonRpcError(error.code, error.message);
    throw error;
  }
}
