import { ToolHandlerError } from '../../lib/tool-response.js';
import type {
  ContentMode,
  OperationsErrorCode,
  ReadNotesToolInput,
  SetPropertyToolInput,
} from './types.js';
import type {
  NoteIdentifier,
  PropertyType,
  PropertyValue,
} from '../../lib/obsidian/vault-provider.js';
import { normalizeVaultPath } from '../../lib/obsidian/paths.js';
import { normalizeNotePath } from '../../lib/obsidian/note-path.js';

export function invalidArgument(message: string, field: string): ToolHandlerError {
  return new ToolHandlerError('INVALID_ARGUMENT' satisfies OperationsErrorCode, message, {
    details: { field },
  });
}

export function resolveIdentifier(
  name: string | undefined,
  pathArg: string | undefined,
): NoteIdentifier {
  if (
    (name === undefined && pathArg === undefined) ||
    (name !== undefined && pathArg !== undefined)
  ) {
    throw invalidArgument(
      'Provide exactly one of name or path',
      name === undefined ? 'name' : 'path',
    );
  }
  if (name !== undefined) {
    if (name.trim() === '') throw invalidArgument('name must not be empty', 'name');
    return { kind: 'name', value: name.trim() };
  }
  try {
    return { kind: 'path', value: normalizeNotePath(pathArg!) };
  } catch (err) {
    throw invalidArgument((err as Error).message, 'path');
  }
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

export function validateDateValue(value: unknown, type: 'date' | 'datetime'): string {
  if (typeof value !== 'string') {
    throw invalidArgument(`value must be a string when type is ${type}`, 'value');
  }
  const re = type === 'date' ? DATE_RE : DATETIME_RE;
  if (!re.test(value)) {
    const expected = type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss[.sss][Z|±HH:mm]';
    throw invalidArgument(`value must be ISO ${expected} when type is ${type}`, 'value');
  }
  if (Number.isNaN(Date.parse(value))) {
    throw invalidArgument(`value is not a valid ${type}`, 'value');
  }
  return value;
}

export function inferTypeAndValidate(
  value: unknown,
  explicitType: SetPropertyToolInput['type'],
): { value: PropertyValue; type: PropertyType | undefined } {
  if (value === null || value === undefined) {
    throw new ToolHandlerError(
      'UNSUPPORTED_VALUE_TYPE' satisfies OperationsErrorCode,
      'value must not be null or undefined',
      { details: { value } },
    );
  }

  if (explicitType === 'date' || explicitType === 'datetime') {
    return { value: validateDateValue(value, explicitType), type: explicitType };
  }

  if (Array.isArray(value)) {
    const stringified = value.map((v) => {
      if (typeof v !== 'string' && typeof v !== 'number') {
        throw new ToolHandlerError(
          'UNSUPPORTED_VALUE_TYPE' satisfies OperationsErrorCode,
          'list items must be string or number',
          { details: { value } },
        );
      }
      return String(v);
    });
    if (stringified.some((s) => s.includes(','))) {
      throw invalidArgument('list items must not contain commas', 'value');
    }
    return { value: stringified, type: explicitType ?? 'list' };
  }

  if (typeof value === 'string') {
    return { value, type: explicitType ?? 'text' };
  }
  if (typeof value === 'number') {
    return { value, type: explicitType ?? 'number' };
  }
  if (typeof value === 'boolean') {
    return { value, type: explicitType ?? 'checkbox' };
  }

  throw new ToolHandlerError(
    'UNSUPPORTED_VALUE_TYPE' satisfies OperationsErrorCode,
    `value of type ${typeof value} is not supported`,
    { details: { value } },
  );
}

export function normalizePath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    throw invalidArgument((err as Error).message, 'path');
  }
}

export const VALID_CONTENT_MODES: readonly ContentMode[] = ['full', 'preview', 'frontmatter'];

export function validateReadNotesInput(input: ReadNotesToolInput): {
  paths: string[];
  content: ContentMode | undefined;
} {
  let paths: string[];
  if (typeof input.paths === 'string') {
    if (input.paths === '') {
      throw invalidArgument('paths must not be empty', 'paths');
    }
    paths = [input.paths];
  } else if (Array.isArray(input.paths)) {
    paths = input.paths;
  } else {
    throw invalidArgument('paths must be a string or an array of strings', 'paths');
  }
  if (paths.length < 1 || paths.length > 50) {
    throw invalidArgument('paths must contain between 1 and 50 entries', 'paths');
  }
  let content: ContentMode | undefined;
  if (input.content === undefined) {
    content = undefined;
  } else if (VALID_CONTENT_MODES.includes(input.content)) {
    content = input.content;
  } else {
    throw invalidArgument(
      `unknown content mode '${String(input.content)}'; allowed: ${VALID_CONTENT_MODES.join(', ')}`,
      'content',
    );
  }
  return { paths, content };
}
