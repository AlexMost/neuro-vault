import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, normalizePath } from '../tool-helpers.js';
import type { CreateNoteToolInput } from '../types.js';
import type { VaultProvider } from '../vault-provider.js';

const inputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  content: z.string().optional(),
  template: z.string().optional(),
  overwrite: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface CreateNoteDeps {
  provider: VaultProvider;
}

export function buildCreateNoteTool(deps: CreateNoteDeps): ITool<Input, { path: string }> {
  const { provider } = deps;
  return {
    name: 'create_note',
    title: 'Create Note',
    description:
      'Create a new note. Provide `name` or `path`. Optional `content` and `template`. If a note with this path/name might already exist and the user has not explicitly asked to replace it, ask the user before passing `overwrite: true` — overwrite is destructive. Default behavior fails when the note exists.',
    inputSchema,
    handler: async (input) => {
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
  };
}
