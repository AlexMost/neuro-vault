import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument } from '../tool-helpers.js';
import { normalizeNotePath } from '../../../lib/obsidian/note-path.js';
import type { CreateNoteToolInput } from '../types.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  content?: string;
  overwrite?: boolean;
}

export interface CreateNoteDeps {
  registry: IVaultRegistry;
}

export function buildCreateNoteTool(
  deps: CreateNoteDeps,
): ITool<Input, { vault: string; path: string }> {
  const { registry } = deps;
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    name: z.string().optional(),
    path: z.string().optional(),
    content: z.string().optional(),
    overwrite: z.boolean().optional(),
  });
  return {
    name: 'create_note',
    title: 'Create Note',
    description:
      'Create a new note. Provide `name` or `path` (exactly one). ' +
      'Optionally provide `content` (raw markdown for the note body and frontmatter). ' +
      'Paths without an extension are treated as `.md` notes.' +
      '\n\n' +
      'Before composing `content`, sample 1–2 similar notes from the vault to mimic existing conventions instead of inventing your own. A reliable pattern: `search_notes` for the topic (or `query_notes` with a tag/folder filter that fits) to find candidates, then `read_notes` on the closest match to inspect its frontmatter shape, tag values, heading layout, and folder placement. Match those conventions — the user almost always prefers a new note that looks like its neighbours. Be especially careful with the `type` frontmatter field: vaults tend to use a small closed set (e.g. project / task / idea / reflection / daily / review / inbox / resource); pick from what other notes use rather than coining a new value.' +
      '\n\n' +
      'Templates are not handled by this tool — render any template yourself (Obsidian Core Templates, Templater, or anything else) and pass the result as `content`.' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ) +
      ' If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'create_note' });
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
        try {
          passthrough.path = normalizeNotePath(input.path);
        } catch (err) {
          throw invalidArgument((err as Error).message, 'path');
        }
      }
      if (input.overwrite !== undefined) passthrough.overwrite = input.overwrite;
      if (input.content !== undefined) passthrough.content = input.content;

      const result = await entry.provider.createNote(passthrough);
      return { vault: entry.name, ...result };
    },
  };
}
