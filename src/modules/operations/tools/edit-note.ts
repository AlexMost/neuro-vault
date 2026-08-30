import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument } from '../tool-helpers.js';
import { normalizeNotePath } from '../../../lib/obsidian/note-path.js';
import { resolveNoteName } from '../resolve-note-name.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  content: string;
  replace?: string;
}

export interface EditNoteDeps {
  registry: IVaultRegistry;
}

export function buildEditNoteTool(deps: EditNoteDeps): ITool<Input, { vault: string }> {
  const { registry } = deps;
  return buildSingleVaultTool<Input, { vault: string }>(registry, {
    name: 'edit_note',
    title: 'Edit Note',
    description:
      'Edit an existing note. Pass `replace` for a targeted find/replace inside the body, or omit it to overwrite the entire body. Frontmatter is preserved byte-for-byte either way. ' +
      '\n\n' +
      'With `replace`: the exact string in `replace` is located in the body (case- and whitespace-sensitive) and swapped for `content`. If the string is not found, the call fails with `NOT_FOUND`. If it appears more than once, the call fails with `AMBIGUOUS_MATCH` listing the line numbers — make `replace` more specific, or omit it to do a full rewrite.' +
      '\n\n' +
      'Without `replace`: the entire body is overwritten with `content`. Use this for whole-body rewrites; pre-fetch the body with `read_notes` if you need to preserve parts of it. Use `\\n` for newlines in either mode.' +
      '\n\n' +
      'Writes land in the vault directory directly on disk — Obsidian does not need to be installed or running. Editing while a live Obsidian session has the vault open is permitted, but the last writer wins per file — a concurrent Obsidian save can silently overwrite this edit, and vice versa.',
    inputShape: {
      name: z.string().optional(),
      path: z.string().optional(),
      content: z.string(),
      replace: z.string().optional(),
    },
    runForEntry: async (entry, input) => {
      if (
        (input.name === undefined && input.path === undefined) ||
        (input.name !== undefined && input.path !== undefined)
      ) {
        throw invalidArgument(
          'Provide exactly one of name or path',
          input.name === undefined ? 'name' : 'path',
        );
      }

      const path = await resolveToPath(input, entry.reader);

      if (input.replace !== undefined) {
        if (input.replace === '') {
          throw invalidArgument('replace must not be empty', 'replace');
        }
        await entry.writer.replaceInNote({
          path,
          find: input.replace,
          content: input.content,
        });
      } else {
        await entry.writer.replaceFullBody({ path, content: input.content });
      }

      return { vault: entry.name };
    },
  });
}

async function resolveToPath(input: Input, reader: VaultReader): Promise<string> {
  if (input.path !== undefined) {
    try {
      return normalizeNotePath(input.path);
    } catch (err) {
      throw invalidArgument((err as Error).message, 'path');
    }
  }
  const name = input.name!.trim();
  if (name === '') {
    throw invalidArgument('name must not be empty', 'name');
  }
  return resolveNoteName(reader, name);
}
