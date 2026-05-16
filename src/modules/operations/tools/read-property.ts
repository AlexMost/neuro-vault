import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';

const inputSchema = z.object({
  vault: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  key: z.string(),
});

type Input = z.infer<typeof inputSchema>;

export interface ReadPropertyDeps {
  registry: IVaultRegistry;
}

export function buildReadPropertyTool(
  deps: ReadPropertyDeps,
): ITool<Input, { vault: string; value: string | number | boolean | string[] | number[] }> {
  const { registry } = deps;
  return {
    name: 'read_property',
    title: 'Read Property',
    description:
      'Read a frontmatter property value from a note. Provide `name` or `path`, plus `key`. Returns `{ vault, value }`. Use `read_notes` if you need the full frontmatter or accurate type information. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'read_property' });
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      const result = await entry.provider!.readProperty({ identifier, name: input.key.trim() });
      return { vault: entry.name, ...result };
    },
  };
}
