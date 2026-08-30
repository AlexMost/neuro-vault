import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { buildSingleVaultTool } from '../../../lib/single-vault-tool.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';

interface Input {
  vault?: string;
  name?: string;
  path?: string;
  key: string;
}

export interface RemovePropertyDeps {
  registry: IVaultRegistry;
}

export function buildRemovePropertyTool(
  deps: RemovePropertyDeps,
): ITool<Input, { vault: string; ok: true }> {
  const { registry } = deps;
  return buildSingleVaultTool<Input, { vault: string; ok: true }>(registry, {
    name: 'remove_property',
    title: 'Remove Property',
    description:
      'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed. Returns `{ vault, ok: true }`.',
    inputShape: {
      name: z.string().optional(),
      path: z.string().optional(),
      key: z.string(),
    },
    runForEntry: async (entry, input) => {
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await entry.provider.removeProperty({ identifier, name: input.key.trim() });
      return { vault: entry.name, ok: true as const };
    },
  });
}
