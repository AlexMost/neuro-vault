export type OperationsErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'NOTE_EXISTS'
  | 'PROPERTY_NOT_FOUND'
  | 'TAG_NOT_FOUND'
  | 'UNSUPPORTED_VALUE_TYPE'
  | 'CLI_NOT_FOUND'
  | 'CLI_UNAVAILABLE'
  | 'CLI_TIMEOUT'
  | 'CLI_ERROR'
  | 'READ_FAILED';

export type ReadNotesField = 'frontmatter' | 'content';

export interface ReadNotesToolInput {
  paths: string[];
  fields?: ReadNotesField[];
}

export interface ReadNotesResultItemSuccess {
  path: string;
  frontmatter?: Record<string, unknown> | null;
  content?: string;
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
  template?: string;
  overwrite?: boolean;
}

export type EditPositionToolInput = 'append' | 'prepend';

export interface EditNoteToolInput {
  name?: string;
  path?: string;
  content: string;
  position: EditPositionToolInput;
}

export type ReadDailyToolInput = Record<string, never>;

export interface AppendDailyToolInput {
  content: string;
}

export interface SetPropertyToolInput {
  name?: string;
  path?: string;
  key: string;
  value: string | number | boolean | string[] | number[];
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
}

export interface ReadPropertyToolInput {
  name?: string;
  path?: string;
  key: string;
}

export interface RemovePropertyToolInput {
  name?: string;
  path?: string;
  key: string;
}

export type ListPropertiesToolInput = Record<string, never>;
export type ListTagsToolInput = Record<string, never>;

export interface GetTagToolInput {
  tag: string;
  include_files?: boolean;
}

export interface OperationsToolHandlers {
  readNotes(input: ReadNotesToolInput): Promise<ReadNotesResult>;
  createNote(input: CreateNoteToolInput): Promise<{ path: string }>;
  editNote(input: EditNoteToolInput): Promise<void>;
  readDaily(input: ReadDailyToolInput): Promise<{
    path: string;
    frontmatter: Record<string, unknown> | null;
    content: string;
  }>;
  appendDaily(input: AppendDailyToolInput): Promise<void>;
  setProperty(input: SetPropertyToolInput): Promise<{ ok: true }>;
  readProperty(
    input: ReadPropertyToolInput,
  ): Promise<{ value: string | number | boolean | string[] | number[] }>;
  removeProperty(input: RemovePropertyToolInput): Promise<{ ok: true }>;
  listProperties(input: ListPropertiesToolInput): Promise<Array<{ name: string; count: number }>>;
  listTags(input: ListTagsToolInput): Promise<Array<{ name: string; count: number }>>;
  getTag(input: GetTagToolInput): Promise<{ name: string; count: number; files?: string[] }>;
}
