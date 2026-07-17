import { z } from 'zod';

import type { ITool } from '../../../lib/tool-registry.js';
import { resolveVault } from '../../../lib/resolve-vault.js';
import type { IVaultRegistry } from '../../../lib/vault-registry.js';
import { runQueryNotes } from '../../../lib/obsidian/query/index.js';
import { describeMultiVault, vaultParamShape } from '../../../lib/vault-param.js';

const NOTES_TODAY_CAP = 200;
const DAILY_BASENAME_RE = /(\d{4}-\d{2}-\d{2})\.md$/;

interface Input {
  vault?: string;
}

export interface NotesTodayItem {
  vault: string;
  path: string;
  frontmatter: Record<string, unknown>;
  backlink_count: number;
}

export interface ReadDailyHandlerResult {
  vault: string;
  path: string;
  frontmatter: Record<string, unknown> | null;
  content: string;
  notes_today: NotesTodayItem[];
}

export interface ReadDailyDeps {
  registry: IVaultRegistry;
}

export function buildReadDailyTool(deps: ReadDailyDeps): ITool<Input, ReadDailyHandlerResult> {
  const { registry } = deps;
  const inputSchema = z.object({ ...vaultParamShape(registry) });

  return {
    name: 'read_daily',
    title: 'Read Daily',
    description:
      'Read today\'s daily note. Returns `{ vault, path, frontmatter, content, notes_today }` where `frontmatter` is the parsed YAML object (or `null` if absent/malformed), `content` is the body without the YAML block, and `notes_today` lists vault notes created today (matched by `frontmatter.created`) excluding daily notes themselves — metadata only, sorted by path ascending, capped at 200 entries. Each `notes_today` item carries `vault`. Useful for "what\'s on my agenda?" / "what happened today?" questions without a separate `query_notes` call. Fails with DAILY_NOTES_NOT_CONFIGURED if the vault has no Daily Notes plugin configured (missing or empty `.obsidian/daily-notes.json`).' +
      describeMultiVault(
        registry,
        'Pass `vault: "<name>"` to target a specific vault when multiple are registered.',
      ),
    inputSchema,
    handler: async (input) => {
      const entry = resolveVault(input, registry, { tool: 'read_daily' });
      // Config validation lives in the provider: FsVaultProvider.readDaily
      // reads daily-notes.json itself and throws DAILY_NOTES_NOT_CONFIGURED.
      const daily = await entry.provider.readDaily();
      const today = deriveToday(daily.path);
      const query = await runQueryNotes(
        {
          filter: {
            'frontmatter.created': { $regex: `^${today}` },
            'frontmatter.type': { $ne: 'daily' },
          },
          sort: { field: 'path', order: 'asc' },
          limit: NOTES_TODAY_CAP,
        },
        entry.reader,
        entry.graph,
      );

      const notesToday: NotesTodayItem[] = query.results.map((item) => ({
        vault: entry.name,
        path: item.path,
        frontmatter: item.frontmatter,
        backlink_count: item.backlink_count,
      }));

      return {
        vault: entry.name,
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
