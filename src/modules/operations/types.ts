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
  | 'UNSUPPORTED_VALUE_TYPE'
  | 'READ_FAILED'
  | 'WRITE_FAILED'
  | 'AMBIGUOUS_MATCH'
  | 'VAULT_REQUIRED'
  | 'VAULT_NOT_FOUND'
  | 'SEMANTIC_INDEX_NOT_FOUND'
  | 'DAILY_NOTES_NOT_CONFIGURED'
  | 'CREATE_FAILED';

export type ContentMode = 'full' | 'preview' | 'frontmatter';

export interface ReadNotesResultItemSuccess {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  content?: string;
  truncated?: boolean;
}

export interface ReadNotesResultItemError {
  path: string;
  error: {
    code: 'NOT_FOUND' | 'INVALID_ARGUMENT' | 'READ_FAILED';
    message: string;
  };
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
