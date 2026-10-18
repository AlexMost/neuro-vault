import type { RankedNote } from './rank.js';

export interface ILexicalSearchOptions {
  queries: string[];
  allowed?: ReadonlySet<string>;
  noteCap: number;
  perNoteCap: number;
}

export interface ILexicalResult {
  notes: RankedNote[];
  truncated: boolean;
  perQueryCounts: Record<string, number>;
  perQueryTokenCounts: Record<string, Record<string, number>>;
  totalNotes: number;
}

/**
 * How a session reads the lexical leg of a search (design D6): one seam, so
 * the pipeline neither knows nor cares whether the cache behind it lives in
 * this process or in the shared daemon. The reader owns the backlink tie-break
 * and the freshness of whatever feeds it.
 */
export interface ILexicalReader {
  search(opts: ILexicalSearchOptions): Promise<ILexicalResult>;
  /** Starts whatever makes the first search fast; never rejects. */
  warm(): Promise<void>;
}

/**
 * The lexical leg could not be read. A reader throws this and nothing else
 * from `search`, so a caller can tell "the lexical leg is broken" apart from a
 * bug elsewhere in the request.
 */
export class LexicalSearchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LexicalSearchError';
  }
}
