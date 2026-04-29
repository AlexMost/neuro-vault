import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface ListPropertiesDeps {
  provider: VaultProvider;
}

export function buildListPropertiesTool(
  deps: ListPropertiesDeps,
): ITool<Input, Array<{ name: string; count: number }>> {
  const { provider } = deps;
  return {
    name: 'list_properties',
    title: 'List Properties',
    description:
      "List all frontmatter properties used across the vault, sorted by occurrence count desc. Returns `[{name, count}]`. Useful for understanding the vault's metadata ontology.",
    inputSchema,
    handler: async (_input) => {
      return provider.listProperties();
    },
  };
}
