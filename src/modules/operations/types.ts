export type OperationsErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'NOTE_EXISTS'
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

export interface OperationsToolHandlers {
  readNote(input: ReadNoteToolInput): Promise<{ path: string; content: string }>;
  createNote(input: CreateNoteToolInput): Promise<{ path: string }>;
  editNote(input: EditNoteToolInput): Promise<void>;
  readDaily(input: ReadDailyToolInput): Promise<{ path: string; content: string }>;
  appendDaily(input: AppendDailyToolInput): Promise<void>;
}
