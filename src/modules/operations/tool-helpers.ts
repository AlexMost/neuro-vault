import { ToolHandlerError } from '../../lib/tool-response.js';
import type {
  OperationsErrorCode,
  ReadNotesField,
  ReadNotesToolInput,
  SetPropertyToolInput,
} from './types.js';
import type { NoteIdentifier, PropertyType, PropertyValue } from './vault-provider.js';

export const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

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
  return { kind: 'path', value: normalizePath(pathArg!) };
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
    throw invalidArgument(
      `value must be ISO ${expected} when type is ${type} (obsidian-cli silently drops non-ISO values)`,
      'value',
    );
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
      throw invalidArgument(
        'list items containing commas are not supported by obsidian-cli',
        'value',
      );
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
  const trimmed = raw.trim();
  if (!trimmed) throw invalidArgument('path must not be empty', 'path');
  const slashed = trimmed.replace(/\\/g, '/');
  if (slashed.startsWith('/') || WINDOWS_ABSOLUTE_PATH_RE.test(slashed)) {
    throw invalidArgument('path must be vault-relative', 'path');
  }
  if (slashed.split('/').some((segment) => segment === '..')) {
    throw invalidArgument('path must be vault-relative', 'path');
  }
  return slashed.replace(/^\.\//, '');
}

export const VALID_FIELDS: readonly ReadNotesField[] = ['frontmatter', 'content'];
export const DEFAULT_FIELDS: ReadNotesField[] = ['frontmatter', 'content'];

export function validateReadNotesInput(input: ReadNotesToolInput): {
  paths: string[];
  fields: ReadNotesField[];
} {
  if (!Array.isArray(input.paths)) {
    throw invalidArgument('paths must be an array', 'paths');
  }
  if (input.paths.length < 1 || input.paths.length > 50) {
    throw invalidArgument('paths must contain between 1 and 50 entries', 'paths');
  }
  let fields: ReadNotesField[];
  if (input.fields === undefined) {
    fields = DEFAULT_FIELDS;
  } else {
    if (!Array.isArray(input.fields) || input.fields.length === 0) {
      throw invalidArgument('fields must be a non-empty array when provided', 'fields');
    }
    for (const f of input.fields) {
      if (!VALID_FIELDS.includes(f)) {
        throw invalidArgument(
          `unknown field '${String(f)}'; allowed: ${VALID_FIELDS.join(', ')}`,
          'fields',
        );
      }
    }
    fields = input.fields;
  }
  return { paths: input.paths, fields };
}
