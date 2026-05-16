import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';

const inputSchema = z.object({
  vault: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

export interface ListTagsDeps {
  registry: IVaultRegistry;
}

export function buildListTagsTool(
  deps: ListTagsDeps,
): ITool<Input, { vault: string; results: Array<{ name: string; count: number }> }> {
  const { registry } = deps;
  return {
    name: 'list_tags',
    title: 'List Tags',
    description:
      'List all tags used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }`. Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'list_tags' });
      const results = await entry.provider!.listTags();
      return { vault: entry.name, results };
    },
  };
}
