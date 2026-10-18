import type { ICorpusReader } from '../../../lib/obsidian/corpus/corpus.js';
import {
  CorpusNotReadyError,
  type BackendStatus,
  type ISemanticBackend,
} from '../../../lib/obsidian/semantic-backend.js';
import { VaultEntryError, type VaultEntries } from '../../../lib/vault-entry/index.js';
import type { IVaultAttachment } from './attachment.js';

/** What a vault reads until its first attach answers (spec: sessions attach in the background). */
const ATTACHING: BackendStatus = { state: 'indexing', indexed: 0, total: 0 };

export interface ILocalSemanticBackendOptions {
  /** The process's in-process vault entries, shared by every vault's local backend. */
  entries: VaultEntries;
  /** The fixed connection id this process attaches under. */
  connectionId: number;
  /** The vault's one attachment over {@link entries}, shared with every other facade of it. */
  attachment: IVaultAttachment;
  /** The model profile this session serves. */
  profile: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The in-process fallback (design D12): the same vault-entry module the daemon
 * runs, inside the session, so the vault's watcher, reconcile loop and corpus
 * live here instead. The vault is attached once — concurrent first callers
 * share that attach, and the vault reads `indexing` 0/0 until it answers — and
 * a vault that cannot be attached reads `unavailable` and is attached again on
 * the next call.
 *
 * Reads answer as the daemon's corpus service does: a profile that is not
 * `ready` refuses with {@link CorpusNotReadyError} carrying its status, so a
 * caller sees one error vocabulary whichever side serves the vault.
 *
 * `dispose()` releases nothing of its own: the entries are the process's,
 * disposed (watchers, timers, the pass in flight) by whoever built them.
 */
export function createLocalSemanticBackend(opts: ILocalSemanticBackendOptions): ISemanticBackend {
  const { entries, connectionId, attachment, profile } = opts;
  /** The profile's reader, refused unless it is `ready`. */
  async function readerFor(): Promise<ICorpusReader> {
    let key: string;
    try {
      key = await attachment.key();
    } catch (error) {
      if (error instanceof VaultEntryError && error.code === 'VAULT_UNAVAILABLE') {
        throw new CorpusNotReadyError({ state: 'unavailable', reason: error.message });
      }
      throw error;
    }
    const { reader, status } = entries.reader(connectionId, key, profile);
    if (status.state !== 'ready') throw new CorpusNotReadyError(status);
    return reader;
  }

  return {
    async status() {
      try {
        if (!attachment.attached && attachment.attaching) return ATTACHING;
        // Always the live status: another facade may have attached long before this call.
        return entries.status(connectionId, await attachment.key(), profile);
      } catch (error) {
        return { state: 'unavailable', reason: messageOf(error) };
      }
    },
    nearest: async (anchors, readOpts) => (await readerFor()).nearest(anchors, readOpts),
    nearestBlocks: async (anchors, readOpts) =>
      (await readerFor()).nearestBlocks(anchors, readOpts),
    dispose: () => Promise.resolve(),
  };
}
