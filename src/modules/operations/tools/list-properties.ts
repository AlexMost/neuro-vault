import type { IFanOutResult } from '../../../lib/fan-out.js';
import { listProperties } from '../../../lib/obsidian/vault-aggregates.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

type PropertyEntry = { name: string; count: number };
type FlatOutput = { vault: string; results: PropertyEntry[] };
type FanOutPayload = { results: PropertyEntry[] };

export interface ListPropertiesDeps {
  registry: IVaultRegistry;
}

async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await listProperties(entry.reader);
  return { results };
}

export function buildListPropertiesTool(
  deps: ListPropertiesDeps,
): ITool<Input, FlatOutput | IFanOutResult<FanOutPayload>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'list_properties',
    title: 'List Properties',
    description:
      'List ALL frontmatter properties used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }` — the complete inventory, unlike `get_vault_overview` which truncates properties to the top entries. Rare and one-off keys are included, which is what property-consistency audits need.',
    inputShape: {},
    runForEntry,
    single: withVaultName,
  });
}
