import {
  DaemonRpcError,
  type LexicalSearchParams,
  type LexicalSearchResult,
} from '../../../daemon/protocol.js';
import {
  LexicalSearchError,
  type ILexicalReader,
  type ILexicalResult,
  type ILexicalSearchOptions,
} from '../../../lib/obsidian/lexical/reader.js';
import type { IVaultAttachment } from '../backend/attachment.js';
import { DaemonConnectionError, DaemonTimeoutError } from '../daemon-connection.js';
import type { ISharedServices } from '../shared-services.js';

/** A lexical search reads the whole cache once: as generous as a corpus read. */
export const LEXICAL_TIMEOUT_MS = 30_000;

export interface IDaemonLexicalReaderOptions {
  /** The process's connection and one-way switch, shared with every other daemon facade. */
  services: ISharedServices;
  /** The vault's one attachment on the connection, shared with the semantic backend. */
  attachment: IVaultAttachment;
  /** The in-process reader, built once, on the first call after the switch went `local`. */
  local: () => ILexicalReader;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a failure of the daemon's side reads as, for the caller that logs or reports it. */
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
      {
        cause: error,
      },
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
 * The lexical leg over the shared daemon (design D6): `lexical.search` on the
 * vault's one attachment. A failure of the call — the daemon's error, a
 * timeout, a dropped connection — is a {@link LexicalSearchError} for that
 * call only: it never touches the one-way switch, which only `ensure()`
 * flips. `NOT_ATTACHED` also forgets the attach so the next search attaches
 * again. Once `services.ensure()` answers `local`, every call goes to the
 * in-process reader instead.
 */
export function createDaemonLexicalReader(opts: IDaemonLexicalReaderOptions): ILexicalReader {
  const { services, attachment } = opts;
  let localReader: ILexicalReader | undefined;

  function local(): ILexicalReader {
    localReader ??= opts.local();
    return localReader;
  }

  return {
    async search(search: ILexicalSearchOptions): Promise<ILexicalResult> {
      try {
        if ((await services.ensure()) === 'local') return await local().search(search);
        const vault = await attachment.key();
        const params = {
          vault,
          queries: search.queries,
          ...(search.allowed === undefined ? {} : { allowed: [...search.allowed] }),
          note_cap: search.noteCap,
          per_note_cap: search.perNoteCap,
        } satisfies LexicalSearchParams;
        return fromWire(
          await services.connection.request<LexicalSearchResult>(
            'lexical.search',
            params,
            LEXICAL_TIMEOUT_MS,
          ),
        );
      } catch (error) {
        if (error instanceof DaemonRpcError && error.code === 'NOT_ATTACHED') attachment.forget();
        throw failure(error);
      }
    },

    async warm(): Promise<void> {
      try {
        if ((await services.ensure()) === 'local') await local().warm();
        else await attachment.key();
      } catch {
        // Warming is a head start: whatever it could not do, the first search meets again.
      }
    },
  };
}
