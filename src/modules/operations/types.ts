export type {
  NoteRecord,
  QueryNotesResult,
  QueryNotesResultItem,
  QueryNotesSort,
  QueryNotesToolInput,
} from '../../lib/obsidian/query/types.js';

export type OperationsErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_FILTER'
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'NOTE_EXISTS'
  | 'PATH_NOT_FOUND'
  | 'PROPERTY_NOT_FOUND'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'AMBIGUOUS_MATCH'
  | 'VAULT_REQUIRED'
  | 'VAULT_NOT_FOUND'
  | 'SEMANTIC_INDEX_NOT_FOUND'
  | 'DAILY_NOTES_NOT_CONFIGURED'
  | 'CREATE_FAILED';

export type ContentMode = 'full' | 'outline' | 'preview' | 'frontmatter';

/** One heading block of a note's outline; `lines` is the block's whole span. */
export interface OutlineEntry {
  heading: string;
  level: number;
  lines: [number, number];
  hidden?: number;
}

export interface ReadNotesResultItemSuccess {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  content?: string;
  truncated?: boolean;
  lines?: [number, number];
  heading?: string;
  level?: number;
  preamble?: [number, number];
  outline?: OutlineEntry[];
  collapsed?: true;
}

/** Why a selector named no part of its note: the per-item miss codes. */
export type SelectorMissCode = 'HEADING_NOT_FOUND' | 'AMBIGUOUS_MATCH' | 'LINES_OUT_OF_RANGE';

export interface ReadNotesResultItemError {
  path: string;
  error: {
    code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'READ_FAILED' | SelectorMissCode;
    message: string;
  };
  /** A selector miss: the body span, when the note has a body line. */
  lines?: [number, number];
  /** `HEADING_NOT_FOUND`: the note's outline, collapsed as outline mode collapses it. */
  outline?: OutlineEntry[];
  collapsed?: true;
  /** `AMBIGUOUS_MATCH`: every heading block the name matches. */
  matches?: OutlineEntry[];
}

export type ReadNotesResultItem = ReadNotesResultItemSuccess | ReadNotesResultItemError;

export interface ReadNotesResult {
  results: ReadNotesResultItem[];
  count: number;
  errors: number;
}

export interface SetPropertyToolInput {
  name?: string;
  path?: string;
  key: string;
  value: string | number | boolean | string[] | number[];
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
}
