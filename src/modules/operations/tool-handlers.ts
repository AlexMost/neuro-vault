import { ToolHandlerError } from '../../lib/tool-response.js';
import { runQueryNotes } from './query/index.js';
import {
  inferTypeAndValidate,
  invalidArgument,
  normalizePath,
  resolveIdentifier,
  validateReadNotesInput,
} from './tool-helpers.js';
import type {
  AppendDailyToolInput,
  CreateNoteToolInput,
  EditNoteToolInput,
  ListPropertiesToolInput,
  ListTagsToolInput,
  OperationsToolHandlers,
  QueryNotesToolInput,
  ReadDailyToolInput,
  ReadNotesResultItem,
  ReadNotesToolInput,
  ReadPropertyToolInput,
  RemovePropertyToolInput,
  SetPropertyToolInput,
} from './types.js';
import type { VaultProvider } from './vault-provider.js';
import type { VaultReader } from './vault-reader.js';

export interface OperationsHandlerDependencies {
  provider: VaultProvider;
  reader: VaultReader;
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
  };
}
