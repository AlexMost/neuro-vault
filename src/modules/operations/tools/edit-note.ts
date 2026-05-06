import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, normalizePath } from '../tool-helpers.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildBasenameIndex } from '../../../lib/obsidian/link-resolver.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../../lib/obsidian/vault-writer.js';
import type { OperationsErrorCode } from '../types.js';

const baseShape = {
  name: z.string().optional(),
  path: z.string().optional(),
  content: z.string(),
};

const inputSchema = z.discriminatedUnion('position', [
  z.object({ ...baseShape, position: z.literal('append') }),
  z.object({ ...baseShape, position: z.literal('prepend') }),
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
  provider: VaultProvider;
  reader: VaultReader;
  writer: VaultWriter;
}

export function buildEditNoteTool(deps: EditNoteDeps): ITool<Input, void> {
  const { provider, reader, writer } = deps;
  return {
    name: 'edit_note',
    title: 'Edit Note',
    description:
      'Edit an existing note. `position` selects the operation:\n' +
      '- `append` — add `content` at the end of the body.\n' +
      '- `prepend` — add `content` at the start of the body.\n' +
      '- `replace` — exact-string find/replace inside the body. Requires `find`. ' +
      'If `find` matches more than once, the call fails with `AMBIGUOUS_MATCH` ' +
      'unless `replace_all: true`. Frontmatter is never touched.\n' +
      '- `replace_full` — overwrite the entire body with `content`. Frontmatter is preserved byte-for-byte.\n' +
      'Use `\\n` for newlines.',
    inputSchema,
    handler: async (input) => {
      // Identifier validation is shared across all positions.
      if (
        (input.name === undefined && input.path === undefined) ||
        (input.name !== undefined && input.path !== undefined)
      ) {
        throw invalidArgument(
          'Provide exactly one of name or path',
          input.name === undefined ? 'name' : 'path',
        );
      }

      if (input.position === 'append' || input.position === 'prepend') {
        return appendOrPrepend(input, provider);
      }

      // Both replace and replace_full take the direct-fs path.
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

      // replace_full
      return writer.replaceFullBody({ path, content: input.content });
    },
  };
}

async function appendOrPrepend(
  input: Extract<Input, { position: 'append' | 'prepend' }>,
  provider: VaultProvider,
): Promise<void> {
  if (input.content === '') {
    throw invalidArgument('content must not be empty', 'content');
  }
  if (input.name !== undefined) {
    if (input.name.trim() === '') {
      throw invalidArgument('name must not be empty', 'name');
    }
    return provider.editNote({
      identifier: { kind: 'name', value: input.name.trim() },
      content: input.content,
      position: input.position,
    });
  }
  return provider.editNote({
    identifier: { kind: 'path', value: normalizePath(input.path!) },
    content: input.content,
    position: input.position,
  });
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
