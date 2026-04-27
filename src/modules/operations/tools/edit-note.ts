import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';
import type { VaultProvider } from '../vault-provider.js';

const inputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  content: z.string(),
  position: z.enum(['append', 'prepend']),
});

type Input = z.infer<typeof inputSchema>;

export interface EditNoteDeps {
  provider: VaultProvider;
}

export function buildEditNoteTool(deps: EditNoteDeps): ITool<Input, void> {
  const { provider } = deps;
  return {
    name: 'edit_note',
    title: 'Edit Note',
    description:
      'Add content to an existing note at the start (`prepend`) or end (`append`). Use \\n for newlines.',
    inputSchema,
    handler: async (input) => {
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
  };
}
