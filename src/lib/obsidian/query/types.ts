export interface NoteRecord {
  path: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}

export interface QueryNotesSort {
  field: string;
  order: 'asc' | 'desc';
}

export interface QueryNotesToolInput {
  filter: Record<string, unknown>;
  path_prefix?: string;
  sort?: QueryNotesSort;
  limit?: number;
  include_content?: boolean;
}

export interface QueryNotesResultItem {
  path: string;
  frontmatter: Record<string, unknown>;
  content?: string;
}

export interface QueryNotesResult {
  results: QueryNotesResultItem[];
  count: number;
  truncated: boolean;
}
