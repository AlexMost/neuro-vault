import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { VaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';

const inputSchema = z.object({
  vault: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  key: z.string(),
});

type Input = z.infer<typeof inputSchema>;

export interface RemovePropertyDeps {
  registry: VaultRegistry;
}

export function buildRemovePropertyTool(
  deps: RemovePropertyDeps,
): ITool<Input, { vault: string; ok: true }> {
  const { registry } = deps;
  return {
    name: 'remove_property',
    title: 'Remove Property',
    description:
      'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed. Returns `{ vault, ok: true }`. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'remove_property' });
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await entry.provider!.removeProperty({ identifier, name: input.key.trim() });
      return { vault: entry.name, ok: true as const };
    },
  };
}
