import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { invalidArgument, resolveIdentifier } from '../tool-helpers.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

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
  const inputSchema = z.object({
    ...vaultParamShape(registry),
    name: z.string().optional(),
    path: z.string().optional(),
    key: z.string(),
  });
  return {
    name: 'remove_property',
    title: 'Remove Property',
    description:
      'Remove a frontmatter property from a note. Provide `name` or `path`, plus `key`. Idempotent — succeeds whether or not the property existed. Returns `{ vault, ok: true }`.' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ),
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'remove_property' });
      const identifier = resolveIdentifier(input.name, input.path);
      if (!input.key || input.key.trim() === '') {
        throw invalidArgument('key must not be empty', 'key');
      }
      await entry.provider.removeProperty({ identifier, name: input.key.trim() });
      return { vault: entry.name, ok: true as const };
    },
  };
}
