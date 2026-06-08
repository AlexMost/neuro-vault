export type NoteIdentifier = { kind: 'name'; value: string } | { kind: 'path'; value: string };

export interface CreateNoteInput {
  name?: string;
  path?: string;
  content?: string;
  overwrite?: boolean;
}

export interface CreateNoteResult {
  path: string;
}

export interface DailyNoteResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
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

export interface VaultProvider {
  createNote(input: CreateNoteInput): Promise<CreateNoteResult>;
  readDaily(): Promise<DailyNoteResult>;
  setProperty(input: SetPropertyInput): Promise<void>;
  removeProperty(input: RemovePropertyInput): Promise<void>;
  listProperties(): Promise<PropertyListEntry[]>;
  listTags(): Promise<TagListEntry[]>;
}
