export type NoteIdentifier =
  | { kind: 'name'; value: string }
  | { kind: 'path'; value: string };

export interface ReadNoteInput {
  identifier: NoteIdentifier;
}

export interface ReadNoteResult {
  path: string;
  content: string;
}

export interface CreateNoteInput {
  name?: string;
  path?: string;
  content?: string;
  template?: string;
  overwrite?: boolean;
}

export interface CreateNoteResult {
  path: string;
}

export type EditPosition = 'append' | 'prepend';

export interface EditNoteInput {
  identifier: NoteIdentifier;
  content: string;
  position: EditPosition;
}

export interface DailyNoteResult {
  path: string;
  content: string;
}

export interface AppendDailyInput {
  content: string;
}

export interface VaultProvider {
  readNote(input: ReadNoteInput): Promise<ReadNoteResult>;
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  editNote(input: EditNoteInput): Promise<void>;
  readDaily(): Promise<DailyNoteResult>;
  appendDaily(input: AppendDailyInput): Promise<void>;
}
