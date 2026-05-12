import path from 'node:path';

import type { VaultReader } from './vault-reader.js';
import type { WikilinkGraphIndex } from './wikilink-graph.js';
import { extractTags } from './query/note-record.js';

export interface VaultOverviewFolder {
  path: string;
  count: number;
}

export interface VaultOverviewTag {
  name: string;
  count: number;
}

export type VaultOverviewPropertyType =
  | 'null'
  | 'boolean'
  | 'number'
  | 'list'
  | 'date'
  | 'string'
  | 'object';

export interface VaultOverviewProperty {
  name: string;
  count: number;
  types: VaultOverviewPropertyType[];
}

export interface VaultOverviewTopNote {
  path: string;
  title: string;
  backlink_count: number;
  type?: string;
}

export interface VaultOverview {
  total_notes: number;
  folders: VaultOverviewFolder[];
  top_tags: VaultOverviewTag[];
  properties: VaultOverviewProperty[];
  top_by_backlinks: VaultOverviewTopNote[];
}

export interface ComputeVaultOverviewDeps {
  reader: VaultReader;
  graph: WikilinkGraphIndex;
}

export const TOP_TAGS_LIMIT = 30;
export const TOP_PROPERTIES_LIMIT = 30;
export const TOP_BACKLINKS_LIMIT = 10;
const READ_BATCH_SIZE = 32;
const ROOT_FOLDER_SENTINEL = '/';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export async function computeVaultOverview(deps: ComputeVaultOverviewDeps): Promise<VaultOverview> {
  const { reader, graph } = deps;
  await graph.ensureFresh();

  const paths = await reader.scan();
  if (paths.length === 0) {
    return {
      total_notes: 0,
      folders: [],
      top_tags: [],
      properties: [],
      top_by_backlinks: [],
    };
  }

  const folders = new Map<string, number>();
  const tags = new Map<string, number>();
  const properties = new Map<string, { count: number; types: Set<VaultOverviewPropertyType> }>();
  const titleByPath = new Map<string, string>();
  const typeByPath = new Map<string, string>();

  let totalNotes = 0;

  for (let i = 0; i < paths.length; i += READ_BATCH_SIZE) {
    const slice = paths.slice(i, i + READ_BATCH_SIZE);
    const items = await reader.readNotes({ paths: slice, fields: ['frontmatter'] });
    for (const item of items) {
      if ('error' in item) continue;
      totalNotes += 1;

      const folder = topLevelFolder(item.path);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);

      const fm = item.frontmatter ?? {};

      for (const tag of extractTags(fm)) {
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
      }

      for (const [key, value] of Object.entries(fm)) {
        const entry = properties.get(key) ?? { count: 0, types: new Set() };
        entry.count += 1;
        entry.types.add(inferType(value));
        properties.set(key, entry);
      }

      titleByPath.set(item.path, basenameWithoutExt(item.path));
      if (typeof fm['type'] === 'string') {
        typeByPath.set(item.path, fm['type']);
      }
    }
  }

  return {
    total_notes: totalNotes,
    folders: sortFolders(folders),
    top_tags: sortByCount(tags).slice(0, TOP_TAGS_LIMIT),
    properties: sortProperties(properties).slice(0, TOP_PROPERTIES_LIMIT),
    top_by_backlinks: collectTopByBacklinks({
      paths,
      graph,
      titleByPath,
      typeByPath,
    }),
  };
}

function topLevelFolder(notePath: string): string {
  const ix = notePath.indexOf('/');
  return ix === -1 ? ROOT_FOLDER_SENTINEL : notePath.slice(0, ix);
}

function basenameWithoutExt(notePath: string): string {
  const base = path.posix.basename(notePath);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

function inferType(value: unknown): VaultOverviewPropertyType {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') {
    return ISO_DATE_RE.test(value) ? 'date' : 'string';
  }
  return 'object';
}

function sortFolders(map: Map<string, number>): VaultOverviewFolder[] {
  return [...map.entries()]
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.path.localeCompare(b.path)));
}

function sortByCount(map: Map<string, number>): Array<{ name: string; count: number }> {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
}

function sortProperties(
  map: Map<string, { count: number; types: Set<VaultOverviewPropertyType> }>,
): VaultOverviewProperty[] {
  return [...map.entries()]
    .map(([name, { count, types }]) => ({
      name,
      count,
      types: [...types].sort() as VaultOverviewPropertyType[],
    }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)));
}

function collectTopByBacklinks(input: {
  paths: string[];
  graph: WikilinkGraphIndex;
  titleByPath: Map<string, string>;
  typeByPath: Map<string, string>;
}): VaultOverviewTopNote[] {
  const { paths, graph, titleByPath, typeByPath } = input;
  const enriched = paths
    .filter((p) => titleByPath.has(p))
    .map((p) => ({
      path: p,
      title: titleByPath.get(p) ?? basenameWithoutExt(p),
      backlink_count: graph.getBacklinkCount(p),
      type: typeByPath.get(p),
    }))
    .sort((a, b) =>
      b.backlink_count !== a.backlink_count
        ? b.backlink_count - a.backlink_count
        : a.path.localeCompare(b.path),
    )
    .slice(0, TOP_BACKLINKS_LIMIT);

  return enriched.map((entry) => {
    const out: VaultOverviewTopNote = {
      path: entry.path,
      title: entry.title,
      backlink_count: entry.backlink_count,
    };
    if (entry.type !== undefined) out.type = entry.type;
    return out;
  });
}
