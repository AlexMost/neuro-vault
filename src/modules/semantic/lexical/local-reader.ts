import {
  LexicalSearchError,
  type ILexicalReader,
  type ILexicalResult,
  type ILexicalSearchOptions,
} from '../../../lib/obsidian/lexical/reader.js';
import { VaultEntryError, type VaultEntries } from '../../../lib/vault-entry/index.js';
import type { IVaultAttachment } from '../backend/attachment.js';

export interface ILocalLexicalReaderOptions {
  /** The process's in-process vault entries. */
  entries: VaultEntries;
  /** The fixed connection id this process attaches under. */
  connectionId: number;
  /** The vault's one attachment, shared with the semantic backend. */
  attachment: IVaultAttachment;
}

/**
 * The lexical leg over this process's own vault entry (design D6): the same
 * cache the daemon would serve, read in-process once the switch went `local`.
 * Every failure — the vault cannot be attached, the entry was detached, the
 * search threw — is a {@link LexicalSearchError}; a detached entry
 * (`NOT_ATTACHED`) also forgets the attach so the next search attaches again.
 */
export function createLocalLexicalReader(opts: ILocalLexicalReaderOptions): ILexicalReader {
  const { entries, connectionId, attachment } = opts;
  return {
    async search(search: ILexicalSearchOptions): Promise<ILexicalResult> {
      try {
        const key = await attachment.key();
        return await entries.lexical(connectionId, key).lexicalSearch(search);
      } catch (cause) {
        if (cause instanceof VaultEntryError && cause.code === 'NOT_ATTACHED') attachment.forget();
        if (cause instanceof LexicalSearchError) throw cause;
        throw new LexicalSearchError(
          `lexical search failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },

    async warm(): Promise<void> {
      try {
        await attachment.key();
      } catch {
        // Warming is a head start: the first search meets whatever failed again.
      }
    },
  };
}
