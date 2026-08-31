import type { IFanOutResult } from '../../../lib/fan-out.js';
import { listTags } from '../../../lib/obsidian/vault-aggregates.js';
import { buildMultiVaultTool, withVaultName } from '../../../lib/multi-vault-tool.js';
import type { ITool } from '../../../lib/tool-registry.js';
import type { IVaultEntry, IVaultRegistry } from '../../../lib/vault-registry.js';

interface Input {
  vault?: string;
}

type TagEntry = { name: string; count: number };
type FlatOutput = { vault: string; results: TagEntry[] };
type FanOutPayload = { results: TagEntry[] };

export interface ListTagsDeps {
  registry: IVaultRegistry;
}

async function runForEntry(entry: IVaultEntry): Promise<FanOutPayload> {
  const results = await listTags(entry.reader);
  return { results };
}

export function buildListTagsTool(
  deps: ListTagsDeps,
): ITool<Input, FlatOutput | IFanOutResult<FanOutPayload>> {
  return buildMultiVaultTool(deps.registry, {
    name: 'list_tags',
    title: 'List Tags',
    description:
      'List all tags used across the vault, sorted by occurrence count desc. Returns `{ vault, results: [{name, count}] }`. Counts aggregate frontmatter `tags:` values and inline body `#tags` (Obsidian grammar), deduplicated per note — each distinct tag counts once per note. Note: the `tags` filter of `query_notes`/`search_notes` matches frontmatter tags only, so a tag that exists only inline is reported here but not filterable there.',
    inputShape: {},
    runForEntry,
    single: withVaultName,
  });
}
