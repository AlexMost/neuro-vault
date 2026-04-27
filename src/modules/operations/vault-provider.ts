export type NoteIdentifier = { kind: 'name'; value: string } | { kind: 'path'; value: string };

export interface ReadNoteInput {
  identifier: NoteIdentifier;
}

export interface ReadNoteResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
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
  frontmatter: Record<string, unknown> | null;
  content: string;
}

export interface AppendDailyInput {
  content: string;
}

export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime';
export type PropertyValue = string | number | boolean | string[] | number[];

export interface SetPropertyInput {
  identifier: NoteIdentifier;
  name: string;
  value: PropertyValue;
  type?: PropertyType;
}

export interface ReadPropertyInput {
  identifier: NoteIdentifier;
  name: string;
}

export interface ReadPropertyResult {
  value: PropertyValue;
}

export interface RemovePropertyInput {
  identifier: NoteIdentifier;
  name: string;
}

export interface PropertyListEntry {
  name: string;
  count: number;
}

export interface TagListEntry {
  name: string;
  count: number;
}

export interface GetTagInput {
  name: string;
  includeFiles?: boolean;
}

export interface GetTagResult {
  name: string;
  count: number;
  files?: string[];
}

export interface VaultProvider {
  readNote(input: ReadNoteInput): Promise<ReadNoteResult>;
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  editNote(input: EditNoteInput): Promise<void>;
  readDaily(): Promise<DailyNoteResult>;
  appendDaily(input: AppendDailyInput): Promise<void>;
  setProperty(input: SetPropertyInput): Promise<void>;
  readProperty(input: ReadPropertyInput): Promise<ReadPropertyResult>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  listProperties(): Promise<PropertyListEntry[]>;
  listTags(): Promise<TagListEntry[]>;
  getTag(input: GetTagInput): Promise<GetTagResult>;
}
