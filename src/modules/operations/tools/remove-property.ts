import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';
import type { VaultProvider } from '../vault-provider.js';

const inputSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  key: z.string(),
});

type Input = z.infer<typeof inputSchema>;

export interface RemovePropertyDeps {
  provider: VaultProvider;
}

export function buildRemovePropertyTool(deps: RemovePropertyDeps): ITool<Input, { ok: true }> {
  const { provider } = deps;
  return {
    name: 'remove_property',
    title: 'Remove Property',
    description:
      'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed.',
    inputSchema,
    handler: async (input) => {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await provider.removeProperty({ identifier, name: input.key.trim() });
      return { ok: true as const };
    },
  };
}
