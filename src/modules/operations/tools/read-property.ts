import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';

const inputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  key: z.string(),
});

type Input = z.infer<typeof inputSchema>;

export interface ReadPropertyDeps {
  provider: VaultProvider;
}

export function buildReadPropertyTool(
  deps: ReadPropertyDeps,
): ITool<Input, { value: string | number | boolean | string[] | number[] }> {
  const { provider } = deps;
  return {
    name: 'read_property',
    title: 'Read Property',
    description:
      'Read a frontmatter property value from a note. Provide `name` or `path`, plus `key`. Returns `{ value }`. Use `read_notes` if you need the full frontmatter or accurate type information.',
    inputSchema,
    handler: async (input) => {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      return provider.readProperty({ identifier, name: input.key.trim() });
    },
  };
}
