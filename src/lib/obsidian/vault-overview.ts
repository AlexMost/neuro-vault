import type { VaultReader } from './vault-reader.js';
import type { VaultProvider } from './vault-provider.js';
import type { WikilinkGraphIndex } from './wikilink-graph.js';
import { topByBacklinks, type TopBacklinkedNote } from './top-by-backlinks.js';

export interface VaultOverviewFolder {
  path: string;
  count: number;
}

export interface VaultOverviewTag {
  name: string;
  count: number;
}

export interface VaultOverviewProperty {
  name: string;
  count: number;
}

export type VaultOverviewTopNote = TopBacklinkedNote;

export interface VaultOverview {
  total_notes: number;
  folders: VaultOverviewFolder[];
  top_tags: VaultOverviewTag[];
  properties: VaultOverviewProperty[];
  top_by_backlinks: VaultOverviewTopNote[];
}

export interface ComputeVaultOverviewDeps {
  reader: VaultReader;
  provider: VaultProvider;
  graph: WikilinkGraphIndex;
}

export const TOP_TAGS_LIMIT = 30;
export const TOP_PROPERTIES_LIMIT = 30;
export const TOP_BACKLINKS_LIMIT = 10;
const ROOT_FOLDER_SENTINEL = '/';

export async function computeVaultOverview(deps: ComputeVaultOverviewDeps): Promise<VaultOverview> {
  const { reader, provider, graph } = deps;
  await graph.ensureFresh();

  const paths = await reader.scan();
  const [tags, props] = await Promise.all([provider.listTags(), provider.listProperties()]);

  if (paths.length === 0) {
    return {
      total_notes: 0,
      folders: [],
      top_tags: tags.slice(0, TOP_TAGS_LIMIT),
      properties: props.slice(0, TOP_PROPERTIES_LIMIT),
      top_by_backlinks: [],
    };
  }

  const folders = new Map<string, number>();
  for (const p of paths) {
    const folder = topLevelFolder(p);
    folders.set(folder, (folders.get(folder) ?? 0) + 1);
  }

  return {
    total_notes: paths.length,
    folders: sortFolders(folders),
    top_tags: tags.slice(0, TOP_TAGS_LIMIT),
    properties: props.slice(0, TOP_PROPERTIES_LIMIT),
    top_by_backlinks: topByBacklinks({ paths, graph, limit: TOP_BACKLINKS_LIMIT }),
  };
}

function topLevelFolder(notePath: string): string {
  const ix = notePath.indexOf('/');
  return ix === -1 ? ROOT_FOLDER_SENTINEL : notePath.slice(0, ix);
}

function sortFolders(map: Map<string, number>): VaultOverviewFolder[] {
  return [...map.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.path.localeCompare(b.path)));
}
