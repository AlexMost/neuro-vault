import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';
import { runFanOut, type IFanOutResult } from '../../../lib/fan-out.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

interface Input {
  vault?: string;
}

type PropertyEntry = { name: string; count: number };
type FlatOutput = { vault: string; results: PropertyEntry[] };
type FanOutPayload = { results: PropertyEntry[] } & Record<string, unknown>;

export interface ListPropertiesDeps {
  registry: IVaultRegistry;
}

async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await entry.provider.listProperties();
  return { results };
}

export function buildListPropertiesTool(
  deps: ListPropertiesDeps,
): ITool<Input, FlatOutput | IFanOutResult<FanOutPayload>> {
  const { registry } = deps;
  const inputSchema = z.object({ ...vaultParamShape(registry) });
  return {
    name: 'list_properties',
    title: 'List Properties',
    description:
      'List ALL frontmatter properties used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }` — the complete inventory, unlike `get_vault_overview` which truncates properties to the top entries. Rare and one-off keys are included, which is what property-consistency audits need.' +
      describeMultiVault(
        registry,
        'In multi-vault mode, omit `vault:` to fan out across all registered vaults — the response shape switches to `results_by_vault: [...]`. Pass `vault: "<name>"` to target a specific vault.',
      ),
    inputSchema,
    handler: async (input) => {
      if (input.vault === undefined && registry.isMulti()) {
        return await runFanOut(registry, runForEntry);
      }
      const entry = resolveVault(input, registry, { tool: 'list_properties' });
      const { results } = await runForEntry(entry);
      return { vault: entry.name, results };
    },
  };
}
