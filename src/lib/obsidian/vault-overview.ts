import type { VaultReader } from './vault-reader.js';
import type { WikilinkGraphIndex } from './wikilink-graph.js';
import { topByBacklinks, type TopBacklinkedNote } from './top-by-backlinks.js';
import { capConventions } from './vault-conventions.js';
import { listProperties, listTags } from './vault-aggregates.js';

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
  /** Raw `.neuro-vault/for-external-agents.md`; absent when the vault has none. */
  conventions?: string;
  /** Present only when `conventions` was trimmed at CONVENTIONS_CHAR_CAP. */
  conventions_truncated?: true;
}

export interface ComputeVaultOverviewDeps {
  reader: VaultReader;
  graph: WikilinkGraphIndex;
  readConventions: () => Promise<string | null>;
}

export const TOP_TAGS_LIMIT = 30;
export const TOP_PROPERTIES_LIMIT = 30;
export const TOP_BACKLINKS_LIMIT = 10;
const ROOT_FOLDER_SENTINEL = '/';

// The conventions file is optional decoration on a structural snapshot: a
// rejection here must never cost the caller the snapshot itself.
async function conventionsFields(
  readConventions: () => Promise<string | null>,
): Promise<Pick<VaultOverview, 'conventions' | 'conventions_truncated'>> {
  let raw: string | null;
  try {
    raw = await readConventions();
  } catch {
    return {};
  }
  if (raw === null || raw === '') return {};
  const { content, truncated } = capConventions(raw);
  return truncated
    ? { conventions: content, conventions_truncated: true }
    : { conventions: content };
}

export async function computeVaultOverview(deps: ComputeVaultOverviewDeps): Promise<VaultOverview> {
  const { reader, graph, readConventions } = deps;
  await graph.ensureFresh();

  const paths = await reader.scan();
  const [tags, props, conventions] = await Promise.all([
    listTags(reader),
    listProperties(reader),
    conventionsFields(readConventions),
  ]);

  if (paths.length === 0) {
    return {
      total_notes: 0,
      folders: [],
      top_tags: tags.slice(0, TOP_TAGS_LIMIT),
      properties: props.slice(0, TOP_PROPERTIES_LIMIT),
      top_by_backlinks: [],
      ...conventions,
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
    ...conventions,
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
