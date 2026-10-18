import type { ILexicalResult } from '../../lib/obsidian/lexical/reader.js';
import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  asRecord,
  DaemonRpcError,
  onlyKeys,
  stringParam,
  type LexicalSearchResult,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

/** The slice of the registry the service uses. */
export type LexicalEntriesPort = Pick<VaultEntries, 'lexical'>;

function invalid(message: string): DaemonRpcError {
  return new DaemonRpcError('INVALID_PARAMS', message);
}

function stringsOf(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((p): p is string => typeof p === 'string')) {
    throw invalid(`${name} must be an array of strings`);
  }
  return value;
}

/** Blank queries pass: the session already normalised them (it never sends fewer than one). */
function queriesParam(params: Record<string, unknown>): string[] {
  const queries = stringsOf(params.queries, 'queries');
  if (queries.length === 0) throw invalid('queries must not be empty');
  return queries;
}

function capParam(params: Record<string, unknown>, name: string): number {
  const value = params[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
}

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
    search: async (params, ctx): Promise<LexicalSearchResult> => {
      const record = asRecord(params);
      onlyKeys(record, ['vault', 'queries', 'allowed', 'note_cap', 'per_note_cap']);
      const vault = stringParam(record, 'vault');
      const queries = queriesParam(record);
      const noteCap = capParam(record, 'note_cap');
      const perNoteCap = capParam(record, 'per_note_cap');
      const allowed =
        record.allowed === undefined ? undefined : stringsOf(record.allowed, 'allowed');
      const entry = await wired(() => entries.lexical(ctx.id, vault));
      try {
        return toWire(
          await entry.lexicalSearch({
            queries,
            ...(allowed === undefined ? {} : { allowed: new Set(allowed) }),
            noteCap,
            perNoteCap,
          }),
        );
      } catch (error) {
        throw new DaemonRpcError(
          'LEXICAL_FAILED',
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
