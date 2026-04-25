import { ToolHandlerError } from '../../lib/tool-response.js';
import type {
  AppendDailyToolInput,
  CreateNoteToolInput,
  EditNoteToolInput,
  OperationsErrorCode,
  OperationsToolHandlers,
  ReadDailyToolInput,
  ReadNoteToolInput,
} from './types.js';
import type { NoteIdentifier, VaultProvider } from './vault-provider.js';

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
  if ((name === undefined && pathArg === undefined) || (name !== undefined && pathArg !== undefined)) {
    throw invalidArgument('Provide exactly one of name or path', name === undefined ? 'name' : 'path');
  }
  if (name !== undefined) {
    if (name.trim() === '') throw invalidArgument('name must not be empty', 'name');
    return { kind: 'name', value: name.trim() };
  }
  return { kind: 'path', value: normalizePath(pathArg!) };
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
    async editNote(_input: EditNoteToolInput) {
      throw new Error('not implemented');
    },
    async readDaily(_input: ReadDailyToolInput) {
      throw new Error('not implemented');
    },
    async appendDaily(_input: AppendDailyToolInput) {
      throw new Error('not implemented');
    },
  };
}
