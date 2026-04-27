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
  | 'CLI_ERROR';

export interface ReadNoteToolInput {
  name?: string;
  path?: string;
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
  file?: string;
  path?: string;
  name: string;
  value: string | number | boolean | string[] | number[];
  type?: 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
}

export interface ReadPropertyToolInput {
  file?: string;
  path?: string;
  name: string;
}

export interface RemovePropertyToolInput {
  file?: string;
  path?: string;
  name: string;
}

export type ListPropertiesToolInput = Record<string, never>;
export type ListTagsToolInput = Record<string, never>;

export interface GetTagToolInput {
  name: string;
  include_files?: boolean;
}

export interface OperationsToolHandlers {
  readNote(input: ReadNoteToolInput): Promise<{
    path: string;
    frontmatter: Record<string, unknown> | null;
    content: string;
  }>;
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
