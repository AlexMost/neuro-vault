import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { runQueryNotes } from '../../../lib/obsidian/query/index.js';
import type { QueryNotesResult, QueryNotesToolInput } from '../../../lib/obsidian/query/types.js';
import type { VaultProvider } from '../../../lib/obsidian/vault-provider.js';
import type { VaultReader } from '../../../lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../lib/obsidian/wikilink-graph.js';

const NOTES_TODAY_CAP = 200;
const DAILY_BASENAME_RE = /(\d{4}-\d{2}-\d{2})\.md$/;

const inputSchema = z.object({});

type Input = z.infer<typeof inputSchema>;

export interface NotesTodayItem {
  path: string;
  frontmatter: Record<string, unknown> | null;
  backlink_count: number;
}

export interface ReadDailyHandlerResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
  notes_today: NotesTodayItem[];
}

export type RunQueryFn = (
  input: QueryNotesToolInput,
  reader: VaultReader,
  graph?: WikilinkGraphIndex,
) => Promise<QueryNotesResult>;

export interface ReadDailyDeps {
  provider: VaultProvider;
  reader: VaultReader;
  graph: WikilinkGraphIndex;
  runQuery?: RunQueryFn;
}

export function buildReadDailyTool(deps: ReadDailyDeps): ITool<Input, ReadDailyHandlerResult> {
  const { provider, reader, graph } = deps;
  const runQuery: RunQueryFn = deps.runQuery ?? runQueryNotes;

  return {
    name: 'read_daily',
    title: 'Read Daily',
    description:
      'Read today\'s daily note. Returns `{ path, frontmatter, content, notes_today }` where `frontmatter` is the parsed YAML object (or `null` if absent/malformed), `content` is the body without the YAML block, and `notes_today` lists vault notes created today (matched by `frontmatter.created`) excluding daily notes themselves — metadata only, sorted by path ascending, capped at 200 entries. Useful for "what\'s on my agenda?" / "what happened today?" questions without a separate `query_notes` call.',
    inputSchema,
    handler: async (_input) => {
      const daily = await provider.readDaily();
      const today = deriveToday(daily.path);
      const query = await runQuery(
        {
          filter: {
            'frontmatter.created': { $regex: `^${today}` },
            'frontmatter.type': { $ne: 'daily' },
          },
          sort: { field: 'path', order: 'asc' },
          limit: NOTES_TODAY_CAP,
        },
        reader,
        graph,
      );

      const notesToday: NotesTodayItem[] = query.results.slice(0, NOTES_TODAY_CAP).map((item) => ({
        path: item.path,
        frontmatter: item.frontmatter,
        backlink_count: item.backlink_count,
      }));

      return {
        path: daily.path,
        frontmatter: daily.frontmatter,
        content: daily.content,
        notes_today: notesToday,
      };
    },
  };
}

function deriveToday(dailyPath: string): string {
  const match = DAILY_BASENAME_RE.exec(dailyPath);
  if (match) return match[1];
  return formatLocalDate(new Date());
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
