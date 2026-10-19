import type { ServiceHandlers } from '../protocol.js';
import { createCorpusService, type CorpusEntriesPort } from './corpus.js';
import { createLexicalService, type LexicalEntriesPort } from './lexical.js';
import { createVaultService, type VaultEntriesPort } from './vault.js';

/** Everything the per-vault services read from the daemon's vault entries. */
export type VaultEntriesPorts = VaultEntriesPort & CorpusEntriesPort & LexicalEntriesPort;

/**
 * What the daemon registers, and what the in-process client dispatches to: the
 * `vault`, `corpus` and `lexical` services over one set of vault entries.
 */
export function createVaultEntryServices(
  entries: VaultEntriesPorts,
): Record<string, ServiceHandlers> {
  return {
    vault: createVaultService(entries),
    corpus: createCorpusService(entries),
    lexical: createLexicalService(entries),
  };
}
