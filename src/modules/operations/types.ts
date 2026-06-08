import type { QueryNotesResult, QueryNotesToolInput } from '../../lib/obsidian/query/types.js';

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
  | 'CLI_NOT_FOUND'
  | 'CLI_UNAVAILABLE'
  | 'CLI_TIMEOUT'
  | 'CLI_ERROR'
  | 'READ_FAILED'
  | 'AMBIGUOUS_MATCH'
  | 'VAULT_REQUIRED'
  | 'VAULT_NOT_FOUND'
  | 'SEMANTIC_INDEX_NOT_FOUND'
  | 'DAILY_NOTES_NOT_CONFIGURED'
  | 'CREATE_FAILED';

export type ContentMode = 'full' | 'preview' | 'frontmatter';

export interface ReadNotesToolInput {
  paths: string | string[];
  content?: ContentMode;
}

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

export interface CreateNoteToolInput {
  name?: string;
  path?: string;
  content?: string;
  overwrite?: boolean;
}

export interface EditNoteToolInput {
  name?: string;
  path?: string;
  content: string;
  replace?: string;
}

export type ReadDailyToolInput = Record<string, never>;

export interface SetPropertyToolInput {
  name?: string;
  path?: string;
  key: string;
  value: string | number | boolean | string[] | number[];
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
}

export interface RemovePropertyToolInput {
  name?: string;
  path?: string;
  key: string;
}

export type ListTagsToolInput = Record<string, never>;

export interface OperationsToolHandlers {
  readNotes(input: ReadNotesToolInput): Promise<ReadNotesResult>;
  queryNotes(input: QueryNotesToolInput): Promise<QueryNotesResult>;
  createNote(input: CreateNoteToolInput): Promise<{ path: string }>;
  editNote(input: EditNoteToolInput): Promise<void>;
  readDaily(input: ReadDailyToolInput): Promise<{
    path: string;
    frontmatter: Record<string, unknown> | null;
    content: string;
    notes_today: Array<{
      path: string;
      frontmatter: Record<string, unknown>;
      backlink_count: number;
    }>;
  }>;
  setProperty(input: SetPropertyToolInput): Promise<{ ok: true }>;
  removeProperty(input: RemovePropertyToolInput): Promise<{ ok: true }>;
  listTags(input: ListTagsToolInput): Promise<Array<{ name: string; count: number }>>;
}
