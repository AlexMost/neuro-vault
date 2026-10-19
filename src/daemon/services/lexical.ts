import type { ILexicalResult } from '../../lib/obsidian/lexical/reader.js';
import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  DaemonRpcError,
  defineMethod,
  lexicalSearchParams,
  type LexicalSearchResult,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

/** The slice of the registry the service uses. */
export type LexicalEntriesPort = Pick<VaultEntries, 'lexical'>;

function toWire(result: ILexicalResult): LexicalSearchResult {
  return {
    notes: result.notes.map((note) => ({
      path: note.path,
      matches: note.matches,
      matched_queries: note.matchedQueries,
    })),
    truncated: result.truncated,
    per_query_counts: result.perQueryCounts,
    per_query_token_counts: result.perQueryTokenCounts,
    total_notes: result.totalNotes,
  };
}

/**
 * `lexical.search` over the daemon's vault entries (design D5). The call carries no profile:
 * the cache belongs to the entry, so any connection attached to the vault may search it. Ranking
 * is the entry's; the session only names the queries, the scope and the caps.
 */
export function createLexicalService(entries: LexicalEntriesPort): ServiceHandlers {
  return {
    search: defineMethod({
      params: lexicalSearchParams,
      handler: async (call, ctx): Promise<LexicalSearchResult> => {
        const entry = await wired(() => entries.lexical(ctx.id, call.vault));
        try {
          return toWire(
            await entry.lexicalSearch({
              queries: call.queries,
              ...(call.allowed === undefined ? {} : { allowed: new Set(call.allowed) }),
              noteCap: call.note_cap,
              perNoteCap: call.per_note_cap,
            }),
          );
        } catch (error) {
          throw new DaemonRpcError(
            'LEXICAL_FAILED',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    }),
  };
}
