import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface ListTagsDeps {
  provider: VaultProvider;
}

export function buildListTagsTool(
  deps: ListTagsDeps,
): ITool<Input, Array<{ name: string; count: number }>> {
  const { provider } = deps;
  return {
    name: 'list_tags',
    title: 'List Tags',
    description:
      'List all tags used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`.',
    inputSchema,
    handler: async (_input) => {
      return provider.listTags();
    },
  };
}
