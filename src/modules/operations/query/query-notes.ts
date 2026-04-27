import siftModule from 'sift';

import { ToolHandlerError } from '../../../lib/tool-response.js';

// sift ships as a CJS module whose default export is the matcher factory.
// Under `module: NodeNext` the default import resolves to the namespace;
// pull the function out explicitly.
type SiftMatcher = (record: unknown) => boolean;
type SiftFactory = (filter: unknown) => SiftMatcher;
const sift: SiftFactory =
  typeof siftModule === 'function'
    ? (siftModule as unknown as SiftFactory)
    : (siftModule as unknown as { default: SiftFactory }).default;
import { ScanPathNotFoundError, type VaultReader } from '../vault-reader.js';
import { toNoteRecord } from './note-record.js';
import type {
  NoteRecord,
  QueryNotesResult,
  QueryNotesResultItem,
  QueryNotesSort,
  QueryNotesToolInput,
} from './types.js';
import { validateFilter } from './whitelist.js';

const DEFAULT_LIMIT = 100;
const HARD_LIMIT_CAP = 1000;
const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

interface ValidatedInput {
  filter: Record<string, unknown>;
  pathPrefix: string | undefined;
  sort: QueryNotesSort | undefined;
  limit: number;
  includeContent: boolean;
}

export async function runQueryNotes(
  input: QueryNotesToolInput,
  reader: VaultReader,
): Promise<QueryNotesResult> {
  const validated = validateInput(input);
  validateFilter(validated.filter);

  let paths: string[];
  try {
    paths = await reader.scan({ pathPrefix: validated.pathPrefix });
  } catch (err) {
    if (err instanceof ScanPathNotFoundError) {
      throw new ToolHandlerError('PATH_NOT_FOUND', err.message, {
        details: { path_prefix: validated.pathPrefix },
      });
    }
    throw err;
  }

  if (paths.length === 0) {
    return { results: [], count: 0, truncated: false };
  }

  const fields = validated.includeContent
    ? (['frontmatter', 'content'] as const)
    : (['frontmatter'] as const);
  const items = await reader.readNotes({ paths, fields: [...fields] });

  type Row = { record: NoteRecord; content?: string };
  const rows: Row[] = [];
  for (const item of items) {
    if ('error' in item) {
      if (item.error.code === 'READ_FAILED') {
        process.stderr.write(`[neuro-vault] query_notes: ${item.error.message}\n`);
      }
      continue;
    }
    const record = toNoteRecord(item);
    rows.push(validated.includeContent ? { record, content: item.content } : { record });
  }

  let matcher: (record: NoteRecord) => boolean;
  try {
    matcher = sift(validated.filter) as unknown as (record: NoteRecord) => boolean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolHandlerError('INVALID_FILTER', `filter rejected by sift: ${message}`);
  }

  let matched: Row[];
  try {
    matched = rows.filter((r) => matcher(r.record));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ToolHandlerError('INVALID_FILTER', `filter execution failed: ${message}`);
  }

  if (validated.sort) {
    sortInPlace(matched, validated.sort);
  }

  const truncated = matched.length > validated.limit;
  const sliced = matched.slice(0, validated.limit);
  const results: QueryNotesResultItem[] = sliced.map((row) =>
    validated.includeContent
      ? {
          path: row.record.path,
          frontmatter: row.record.frontmatter,
          content: row.content!,
        }
      : { path: row.record.path, frontmatter: row.record.frontmatter },
  );

  return { results, count: results.length, truncated };
}

function validateInput(input: QueryNotesToolInput): ValidatedInput {
  if (!input || typeof input !== 'object') {
    throw invalidParams('input must be an object', 'input');
  }
  if (input.filter === undefined || input.filter === null) {
    throw invalidParams('filter is required', 'filter');
  }
  if (typeof input.filter !== 'object' || Array.isArray(input.filter)) {
    throw invalidParams('filter must be a JSON object', 'filter');
  }

  let pathPrefix: string | undefined;
  if (input.path_prefix !== undefined) {
    if (typeof input.path_prefix !== 'string') {
      throw invalidParams('path_prefix must be a string', 'path_prefix');
    }
    pathPrefix = normalizeScanPrefixInput(input.path_prefix);
  }

  let sort: QueryNotesSort | undefined;
  if (input.sort !== undefined) {
    sort = validateSort(input.sort);
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > HARD_LIMIT_CAP
    ) {
      throw invalidParams(`limit must be an integer between 1 and ${HARD_LIMIT_CAP}`, 'limit');
    }
    limit = input.limit;
  }

  let includeContent = false;
  if (input.include_content !== undefined) {
    if (typeof input.include_content !== 'boolean') {
      throw invalidParams('include_content must be a boolean', 'include_content');
    }
    includeContent = input.include_content;
  }

  return {
    filter: input.filter as Record<string, unknown>,
    pathPrefix,
    sort,
    limit,
    includeContent,
  };
}

function normalizeScanPrefixInput(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './') return undefined;
  if (trimmed.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    throw invalidParams('path_prefix must be vault-relative', 'path_prefix');
  }
  const slashed = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  if (slashed.split('/').some((segment) => segment === '..')) {
    throw invalidParams('path_prefix must be vault-relative', 'path_prefix');
  }
  return slashed.replace(/\/+$/, '');
}

function validateSort(raw: unknown): QueryNotesSort {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidParams('sort must be an object { field, order }', 'sort');
  }
  const obj = raw as { field?: unknown; order?: unknown };
  if (typeof obj.field !== 'string' || obj.field.trim() === '') {
    throw invalidParams('sort.field must be a non-empty string', 'sort.field');
  }
  if (obj.field !== 'path' && !obj.field.startsWith('frontmatter.')) {
    throw invalidParams('sort.field must be "path" or start with "frontmatter."', 'sort.field');
  }
  if (obj.order !== 'asc' && obj.order !== 'desc') {
    throw invalidParams('sort.order must be "asc" or "desc"', 'sort.order');
  }
  return { field: obj.field, order: obj.order };
}

function sortInPlace(rows: Array<{ record: NoteRecord }>, sort: QueryNotesSort): void {
  const direction = sort.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const av = readField(a.record, sort.field);
    const bv = readField(b.record, sort.field);
    return compare(av, bv) * direction;
  });
}

function readField(record: NoteRecord, field: string): unknown {
  if (field === 'path') return record.path;
  // field starts with "frontmatter." — drill in
  const segments = field.split('.').slice(1);
  let cursor: unknown = record.frontmatter;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

function compare(a: unknown, b: unknown): number {
  // missing values sort last regardless of asc/desc by convention
  if (a === undefined || a === null) {
    return b === undefined || b === null ? 0 : 1;
  }
  if (b === undefined || b === null) return -1;

  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function invalidParams(message: string, field: string): ToolHandlerError {
  return new ToolHandlerError('INVALID_PARAMS', message, { details: { field } });
}
