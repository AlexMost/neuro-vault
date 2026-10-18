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
