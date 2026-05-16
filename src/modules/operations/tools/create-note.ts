import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, normalizePath } from '../tool-helpers.js';
import type { CreateNoteToolInput } from '../types.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  content?: string;
  template?: string;
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
    template: z.string().optional(),
    overwrite: z.boolean().optional(),
  });
  return {
    name: 'create_note',
    title: 'Create Note',
    description:
      'Create a new note. Provide `name` or `path` (exactly one). Optionally provide `content` (raw markdown for the note body and frontmatter) OR `template` (name of a vault template to apply) — these are mutually exclusive.' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ) +
      ' If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'create_note' });
      if (!entry.provider) {
        throw invalidArgument('operations module is disabled', 'vault');
      }
      if (input.name === undefined && input.path === undefined) {
        throw invalidArgument('Provide name or path', 'name');
      }
      if (input.name !== undefined && input.path !== undefined) {
        throw invalidArgument('Provide exactly one of name or path', 'name');
      }
      if (input.content !== undefined && input.template !== undefined) {
        throw invalidArgument(
          'content and template cannot be used together — call create_note with only one. If you want a note pre-filled from a template, omit content; if you want to write exact markdown, omit template.',
          'content',
        );
      }

      const passthrough: CreateNoteToolInput = {};
      if (input.name !== undefined) {
        if (input.name.trim() === '') throw invalidArgument('name must not be empty', 'name');
        passthrough.name = input.name.trim();
      }
      if (input.path !== undefined) passthrough.path = normalizePath(input.path);
      if (input.content !== undefined) passthrough.content = input.content;
      if (input.template !== undefined) passthrough.template = input.template;
      if (input.overwrite !== undefined) passthrough.overwrite = input.overwrite;

      const result = await entry.provider.createNote(passthrough);
      return { vault: entry.name, ...result };
    },
  };
}
