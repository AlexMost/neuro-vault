import { ToolHandlerError } from '../../lib/tool-response.js';
import { runQueryNotes } from './query/index.js';
import type {
  AppendDailyToolInput,
  CreateNoteToolInput,
  EditNoteToolInput,
  GetTagToolInput,
  ListPropertiesToolInput,
  ListTagsToolInput,
  OperationsErrorCode,
  OperationsToolHandlers,
  QueryNotesToolInput,
  ReadDailyToolInput,
  ReadNotesField,
  ReadNotesResultItem,
  ReadNotesToolInput,
  ReadPropertyToolInput,
  RemovePropertyToolInput,
  SetPropertyToolInput,
} from './types.js';
import type {
  NoteIdentifier,
  PropertyType,
  PropertyValue,
  VaultProvider,
} from './vault-provider.js';
import type { VaultReader } from './vault-reader.js';

export interface OperationsHandlerDependencies {
  provider: VaultProvider;
  reader: VaultReader;
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;

function invalidArgument(message: string, field: string): ToolHandlerError {
  return new ToolHandlerError('INVALID_ARGUMENT' satisfies OperationsErrorCode, message, {
    details: { field },
  });
}

function resolveIdentifier(name: string | undefined, pathArg: string | undefined): NoteIdentifier {
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

function validateDateValue(value: unknown, type: 'date' | 'datetime'): string {
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

function inferTypeAndValidate(
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

function normalizePath(raw: string): string {
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

const VALID_FIELDS: readonly ReadNotesField[] = ['frontmatter', 'content'];
const DEFAULT_FIELDS: ReadNotesField[] = ['frontmatter', 'content'];

function validateReadNotesInput(input: ReadNotesToolInput): {
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

export function createOperationsHandlers(
  deps: OperationsHandlerDependencies,
): OperationsToolHandlers {
  const { provider, reader } = deps;

  return {
    async readNotes(input: ReadNotesToolInput) {
      const { paths, fields } = validateReadNotesInput(input);

      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const p of paths) {
        if (!seen.has(p)) {
          seen.add(p);
          deduped.push(p);
        }
      }

      type Slot = { kind: 'invalid'; item: ReadNotesResultItem } | { kind: 'valid'; path: string };
      const slots: Slot[] = deduped.map((raw) => {
        try {
          const normalized = normalizePath(raw);
          return { kind: 'valid', path: normalized };
        } catch (err) {
          const message = err instanceof ToolHandlerError ? err.message : String(err);
          return {
            kind: 'invalid',
            item: { path: raw, error: { code: 'INVALID_ARGUMENT' as const, message } },
          };
        }
      });

      const validPaths = slots
        .filter((s): s is { kind: 'valid'; path: string } => s.kind === 'valid')
        .map((s) => s.path);

      const readerItems =
        validPaths.length === 0 ? [] : await reader.readNotes({ paths: validPaths, fields });

      const projected: ReadNotesResultItem[] = readerItems.map((item) => {
        if ('error' in item) {
          return item;
        }
        const out: {
          path: string;
          frontmatter?: Record<string, unknown> | null;
          content?: string;
        } = {
          path: item.path,
        };
        if (fields.includes('frontmatter')) {
          out.frontmatter = item.frontmatter;
        }
        if (fields.includes('content')) {
          out.content = item.content;
        }
        return out;
      });

      let projectedIdx = 0;
      const results: ReadNotesResultItem[] = slots.map((slot) => {
        if (slot.kind === 'invalid') return slot.item;
        return projected[projectedIdx++]!;
      });

      const errors = results.reduce((n, r) => n + ('error' in r ? 1 : 0), 0);
      return { results, count: results.length, errors };
    },

    async queryNotes(input: QueryNotesToolInput) {
      return runQueryNotes(input, reader);
    },

    async createNote(input: CreateNoteToolInput) {
      if (input.name === undefined && input.path === undefined) {
        throw invalidArgument('Provide name or path', 'name');
      }
      if (input.name !== undefined && input.path !== undefined) {
        throw invalidArgument('Provide exactly one of name or path', 'name');
      }

      const passthrough: CreateNoteToolInput = {};
      if (input.name !== undefined) {
        if (input.name.trim() === '') throw invalidArgument('name must not be empty', 'name');
        passthrough.name = input.name.trim();
      }
      if (input.path !== undefined) {
        passthrough.path = normalizePath(input.path);
      }
      if (input.content !== undefined) passthrough.content = input.content;
      if (input.template !== undefined) passthrough.template = input.template;
      if (input.overwrite !== undefined) passthrough.overwrite = input.overwrite;

      return provider.createNote(passthrough);
    },
    async editNote(input: EditNoteToolInput) {
      const identifier = resolveIdentifier(input.name, input.path);
      if (input.content === undefined || input.content === '') {
        throw invalidArgument('content must not be empty', 'content');
      }
      if (input.position !== 'append' && input.position !== 'prepend') {
        throw invalidArgument('position must be append or prepend', 'position');
      }
      return provider.editNote({
        identifier,
        content: input.content,
        position: input.position,
      });
    },

    async readDaily(_input: ReadDailyToolInput) {
      return provider.readDaily();
    },

    async appendDaily(input: AppendDailyToolInput) {
      if (input.content === undefined || input.content.trim() === '') {
        throw invalidArgument('content must not be empty', 'content');
      }
      return provider.appendDaily({ content: input.content });
    },

    async setProperty(input: SetPropertyToolInput) {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      const { value, type } = inferTypeAndValidate(input.value, input.type);
      await provider.setProperty({ identifier, name: input.key.trim(), value, type });
      return { ok: true as const };
    },
    async readProperty(input: ReadPropertyToolInput) {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      return provider.readProperty({ identifier, name: input.key.trim() });
    },
    async removeProperty(input: RemovePropertyToolInput) {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await provider.removeProperty({ identifier, name: input.key.trim() });
      return { ok: true as const };
    },
    async listProperties(_input: ListPropertiesToolInput) {
      return provider.listProperties();
    },
    async listTags(_input: ListTagsToolInput) {
      return provider.listTags();
    },
    async getTag(input: GetTagToolInput) {
      const stripped = (input.tag ?? '').trim().replace(/^#/, '').trim();
      if (stripped === '') {
        throw invalidArgument('tag must not be empty', 'tag');
      }
      const includeFiles = input.include_files !== false;
      return provider.getTag({ name: stripped, includeFiles });
    },
  };
}
