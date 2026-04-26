import { ToolHandlerError } from '../../lib/tool-response.js';
import type {
  AppendDailyToolInput,
  CreateNoteToolInput,
  EditNoteToolInput,
  OperationsErrorCode,
  OperationsToolHandlers,
  ReadDailyToolInput,
  ReadNoteToolInput,
  ReadPropertyToolInput,
  RemovePropertyToolInput,
  SetPropertyToolInput,
} from './types.js';
import type { NoteIdentifier, PropertyType, PropertyValue, VaultProvider } from './vault-provider.js';

export interface OperationsHandlerDependencies {
  provider: VaultProvider;
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

function resolvePropertyTarget(
  file: string | undefined,
  pathArg: string | undefined,
): NoteIdentifier {
  if (
    (file === undefined && pathArg === undefined) ||
    (file !== undefined && pathArg !== undefined)
  ) {
    throw invalidArgument(
      'Provide exactly one of file or path',
      file === undefined ? 'file' : 'path',
    );
  }
  if (file !== undefined) {
    if (file.trim() === '') throw invalidArgument('file must not be empty', 'file');
    return { kind: 'name', value: file.trim() };
  }
  return { kind: 'path', value: normalizePath(pathArg!) };
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

export function createOperationsHandlers(
  deps: OperationsHandlerDependencies,
): OperationsToolHandlers {
  const { provider } = deps;

  return {
    async readNote(input: ReadNoteToolInput) {
      const identifier = resolveIdentifier(input.name, input.path);
      return provider.readNote({ identifier });
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
      const identifier = resolvePropertyTarget(input.file, input.path);
      if (!input.name || input.name.trim() === '') {
        throw invalidArgument('name must not be empty', 'name');
      }
      const { value, type } = inferTypeAndValidate(input.value, input.type);
      await provider.setProperty({ identifier, name: input.name.trim(), value, type });
      return { ok: true as const };
    },
    async readProperty(input: ReadPropertyToolInput) {
      const identifier = resolvePropertyTarget(input.file, input.path);
      if (!input.name || input.name.trim() === '') {
        throw invalidArgument('name must not be empty', 'name');
      }
      return provider.readProperty({ identifier, name: input.name.trim() });
    },
    async removeProperty(input: RemovePropertyToolInput) {
      const identifier = resolvePropertyTarget(input.file, input.path);
      if (!input.name || input.name.trim() === '') {
        throw invalidArgument('name must not be empty', 'name');
      }
      await provider.removeProperty({ identifier, name: input.name.trim() });
      return { ok: true as const };
    },
    async listProperties() {
      throw new Error('not implemented');
    },
    async listTags() {
      throw new Error('not implemented');
    },
    async getTag() {
      throw new Error('not implemented');
    },
  };
}
