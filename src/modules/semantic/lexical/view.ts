import type { LexicalSearchResult } from '../../../daemon/protocol.js';
import {
  LexicalSearchError,
  type ILexicalReader,
  type ILexicalResult,
  type ILexicalSearchOptions,
} from '../../../lib/obsidian/lexical/reader.js';
import { DaemonConnectionError, DaemonTimeoutError } from '../daemon-connection.js';
import type { IVaultClient } from '../vault-client/index.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a failed search reads as, for the caller that logs or reports it. */
function failure(error: unknown): LexicalSearchError {
  if (error instanceof LexicalSearchError) return error;
  if (error instanceof DaemonTimeoutError) {
    return new LexicalSearchError('daemon did not answer lexical.search in time', {
      cause: error,
    });
  }
  if (error instanceof DaemonConnectionError) {
    return new LexicalSearchError(
      `daemon connection lost during lexical.search: ${error.message}`,
      { cause: error },
    );
  }
  return new LexicalSearchError(`lexical search failed: ${messageOf(error)}`, { cause: error });
}

function fromWire(result: LexicalSearchResult | undefined): ILexicalResult {
  if (!Array.isArray(result?.notes)) {
    throw new LexicalSearchError('daemon answered lexical.search without a notes list');
  }
  return {
    notes: result.notes.map((note) => ({
      path: note.path,
      matches: note.matches,
      matchedQueries: note.matched_queries,
    })),
    truncated: result.truncated,
    perQueryCounts: result.per_query_counts,
    perQueryTokenCounts: result.per_query_token_counts,
    totalNotes: result.total_notes,
  };
}

/**
 * The session's lexical leg over the vault's client, whichever side serves the vault: a
 * search is one `lexical.search` call, the warm-up is the client's.
 *
 * The client does no domain mapping, so the view owns the one this interface needs: every
 * failure of a search — the entry's (`LEXICAL_FAILED`), a vault that cannot be attached, a
 * timeout, a dropped connection, closed services — is a {@link LexicalSearchError} for that
 * call only. None of them flips the switch, and a `NOT_ATTACHED` has already made the client
 * forget its attach, so the next search attaches again.
 */
export function createLexicalReaderView(client: IVaultClient): ILexicalReader {
  return {
    async search(search: ILexicalSearchOptions): Promise<ILexicalResult> {
      try {
        return fromWire(
          await client.call('lexical.search', {
            queries: search.queries,
            ...(search.allowed === undefined ? {} : { allowed: [...search.allowed] }),
            note_cap: search.noteCap,
            per_note_cap: search.perNoteCap,
          }),
        );
      } catch (error) {
        throw failure(error);
      }
    },

    warm: () => client.warm(),
  };
}
