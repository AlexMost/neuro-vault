import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, normalizePath } from '../tool-helpers.js';
import { ToolHandlerError } from '../../../lib/tool-response.js';
import { buildBasenameIndex } from '../../../lib/obsidian/link-resolver.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { VaultWriter } from '../../../lib/obsidian/vault-writer.js';
import type { OperationsErrorCode } from '../types.js';

const inputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  content: z.string(),
  replace: z.string().optional(),
});

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
      'Edit an existing note. Pass `replace` for a targeted find/replace inside the body, or omit it to overwrite the entire body. Frontmatter is preserved byte-for-byte either way. ' +
      '\n\n' +
      'With `replace`: the exact string in `replace` is located in the body (case- and whitespace-sensitive) and swapped for `content`. If the string is not found, the call fails with `NOT_FOUND`. If it appears more than once, the call fails with `AMBIGUOUS_MATCH` listing the line numbers — make `replace` more specific, or omit it to do a full rewrite.' +
      '\n\n' +
      'Without `replace`: the entire body is overwritten with `content`. Use this for whole-body rewrites; pre-fetch the body with `read_notes` if you need to preserve parts of it. Use `\\n` for newlines in either mode.',
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

      if (input.replace !== undefined) {
        if (input.replace === '') {
          throw invalidArgument('replace must not be empty', 'replace');
        }
        return writer.replaceInNote({
          path,
          find: input.replace,
          content: input.content,
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
      `Multiple notes match name '${name}': ${matches.join(', ')}; pass an explicit path`,
      { details: { name, matches } },
    );
  }
  return matches[0]!;
}
