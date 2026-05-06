import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, normalizePath } from '../tool-helpers.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildBasenameIndex } from '../../../lib/obsidian/link-resolver.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../../lib/obsidian/vault-writer.js';
import type { OperationsErrorCode } from '../types.js';

const baseShape = {
  name: z.string().optional(),
  path: z.string().optional(),
  content: z.string(),
};

const inputSchema = z.discriminatedUnion('position', [
  z.object({
    ...baseShape,
    position: z.literal('replace'),
    find: z.string(),
    replace_all: z.boolean().optional(),
  }),
  z.object({ ...baseShape, position: z.literal('replace_full') }),
]);

type Input = z.infer<typeof inputSchema>;

export interface EditNoteDeps {
  reader: VaultReader;
  writer: VaultWriter;
}

export function buildEditNoteTool(deps: EditNoteDeps): ITool<Input, void> {
  const { reader, writer } = deps;
  return {
    name: 'edit_note',
    title: 'Edit Note',
    description:
      'Edit an existing note. `position` selects the operation:\n' +
      '- `replace` — exact-string find/replace inside the body. Requires `find`. ' +
      'If `find` matches more than once, the call fails with `AMBIGUOUS_MATCH` ' +
      'unless `replace_all: true`. Frontmatter is never touched.\n' +
      '- `replace_full` — overwrite the entire body with `content`. Frontmatter is preserved byte-for-byte.\n' +
      'For "add to end / start of body" use `read_notes` to fetch the current body, ' +
      'modify it locally, and call `replace_full`. Use `\\n` for newlines.',
    inputSchema,
    handler: async (input) => {
      if (
        (input.name === undefined && input.path === undefined) ||
        (input.name !== undefined && input.path !== undefined)
      ) {
        throw invalidArgument(
          'Provide exactly one of name or path',
          input.name === undefined ? 'name' : 'path',
        );
      }

      const path = await resolveToPath(input, reader);

      if (input.position === 'replace') {
        if (input.find === '') {
          throw invalidArgument('find must not be empty', 'find');
        }
        return writer.replaceInNote({
          path,
          find: input.find,
          content: input.content,
          replaceAll: input.replace_all === true,
        });
      }

      return writer.replaceFullBody({ path, content: input.content });
    },
  };
}

async function resolveToPath(input: Input, reader: VaultReader): Promise<string> {
  if (input.path !== undefined) {
    return normalizePath(input.path);
  }
  const name = input.name!.trim();
  if (name === '') {
    throw invalidArgument('name must not be empty', 'name');
  }
  const matches = buildBasenameIndex(await reader.scan()).resolveAll(name);
  if (matches.length === 0) {
    throw new ToolHandlerError(
      'NOT_FOUND' satisfies OperationsErrorCode,
      `Note not found for name: ${name}`,
      { details: { name } },
    );
  }
  if (matches.length > 1) {
    throw new ToolHandlerError(
      'AMBIGUOUS_MATCH' satisfies OperationsErrorCode,
      `Multiple notes match name '${name}'; pass an explicit path`,
      { details: { name, matches } },
    );
  }
  return matches[0]!;
}
