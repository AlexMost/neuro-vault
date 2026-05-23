import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { buildReadDailyTool } from '../../../src/modules/operations/tools/read-daily.js';
import { type ReadNotesItem, type VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeGraph, makeProvider } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

interface FakeNote {
  path: string;
  frontmatter: Record<string, unknown>;
}

function buildReader(notes: FakeNote[]): VaultReader {
  return {
    scan: vi.fn(async () => notes.map((n) => n.path)),
    readNotes: vi.fn(async ({ paths }: { paths: string[] }): Promise<ReadNotesItem[]> => {
      const byPath = new Map(notes.map((n) => [n.path, n]));
      return paths.map((p) => {
        const note = byPath.get(p);
        if (!note) {
          return { path: p, error: { code: 'NOT_FOUND' as const, message: 'missing' } };
        }
        return { path: note.path, frontmatter: note.frontmatter, content: '' };
      });
    }),
  };
}

function dailyProvider(dailyPath: string, content = '') {
  return makeProvider({
    readDaily: vi.fn().mockResolvedValue({ path: dailyPath, frontmatter: null, content }),
  });
}

describe('operations.readDaily handler', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'read-daily-test-'));
    await mkdir(join(tmpDir, '.obsidian'), { recursive: true });
    await writeFile(
      join(tmpDir, '.obsidian', 'daily-notes.json'),
      JSON.stringify({ folder: '01 Daily' }),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws DAILY_NOTES_NOT_CONFIGURED before invoking the provider on an unconfigured vault', async () => {
    // Use a fresh tmp dir with NO .obsidian/daily-notes.json
    const emptyDir = await mkdtemp(join(tmpdir(), 'read-daily-unconfigured-'));
    try {
      const provider = makeProvider({
        readDaily: vi.fn().mockRejectedValue(new Error('should not be called')),
      });
      const registry = makeTestRegistry([{ name: 'v', path: emptyDir, provider, reader: buildReader([]), graph: makeGraph() }]);
      const tool = buildReadDailyTool({ registry });

      await expect(tool.handler({})).rejects.toMatchObject({
        code: 'DAILY_NOTES_NOT_CONFIGURED',
      });
      expect(provider.readDaily).not.toHaveBeenCalled();
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('forwards to provider.readDaily and returns daily fields with vault', async () => {
    const provider = dailyProvider('Daily/2026-05-12.md', 'today');
    const graph = makeGraph();
    const registry = makeTestRegistry([{ name: 'v', path: tmpDir, provider, reader: buildReader([]), graph }]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(provider.readDaily).toHaveBeenCalledTimes(1);
    expect(result.vault).toBe('v');
    expect(result.path).toBe('Daily/2026-05-12.md');
    expect(result.frontmatter).toBeNull();
    expect(result.content).toBe('today');
  });

  it('returns notes_today: [] when no notes were created today', async () => {
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader([
          { path: 'Notes/old.md', frontmatter: { created: '2026-05-01', type: 'reflection' } },
        ]),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today).toEqual([]);
  });

  it('returns notes created today and excludes type: daily', async () => {
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader([
          { path: 'Daily/2026-05-12.md', frontmatter: { created: '2026-05-12', type: 'daily' } },
          {
            path: 'Reflections/morning.md',
            frontmatter: { created: '2026-05-12', type: 'reflection' },
          },
          { path: 'Tasks/buy-milk.md', frontmatter: { created: '2026-05-12', type: 'task' } },
          { path: 'Notes/old.md', frontmatter: { created: '2026-05-11', type: 'reflection' } },
        ]),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today.map((n) => n.path)).toEqual([
      'Reflections/morning.md',
      'Tasks/buy-milk.md',
    ]);
  });

  it('matches frontmatter.created when it is an ISO datetime, not just a date', async () => {
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader([
          {
            path: 'Notes/morning.md',
            frontmatter: { created: '2026-05-12', type: 'reflection' },
          },
          {
            path: 'Notes/afternoon.md',
            frontmatter: { created: '2026-05-12T14:30:00', type: 'reflection' },
          },
          {
            path: 'Notes/wrong-day.md',
            frontmatter: { created: '2026-05-13T00:00:00', type: 'reflection' },
          },
        ]),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today.map((n) => n.path)).toEqual([
      'Notes/afternoon.md',
      'Notes/morning.md',
    ]);
  });

  it('projects each entry to { vault, path, frontmatter, backlink_count } and drops content', async () => {
    const graph = makeGraph({
      getBacklinkCount: vi.fn((p: string) => (p === 'Reflections/morning.md' ? 2 : 0)),
    });
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader([
          {
            path: 'Reflections/morning.md',
            frontmatter: { created: '2026-05-12', type: 'reflection' },
          },
        ]),
        graph,
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today).toEqual([
      {
        vault: 'v',
        path: 'Reflections/morning.md',
        frontmatter: { created: '2026-05-12', type: 'reflection' },
        backlink_count: 2,
      },
    ]);
    for (const item of result.notes_today) {
      expect(item).not.toHaveProperty('content');
      expect(item).not.toHaveProperty('tags');
    }
  });

  it('sorts notes_today by path ascending', async () => {
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader([
          { path: 'C.md', frontmatter: { created: '2026-05-12' } },
          { path: 'A.md', frontmatter: { created: '2026-05-12' } },
          { path: 'B.md', frontmatter: { created: '2026-05-12' } },
        ]),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today.map((n) => n.path)).toEqual(['A.md', 'B.md', 'C.md']);
  });

  it('caps notes_today at 200 entries when more notes match', async () => {
    const oversized = Array.from({ length: 250 }, (_, i) => ({
      path: `Notes/${String(i).padStart(3, '0')}.md`,
      frontmatter: { created: '2026-05-12' },
    }));
    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/2026-05-12.md'),
        reader: buildReader(oversized),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today.length).toBe(200);
    expect(result.notes_today[0].path).toBe('Notes/000.md');
    expect(result.notes_today[199].path).toBe('Notes/199.md');
  });

  it('uses the local date when the daily-note basename is not YYYY-MM-DD', async () => {
    // The fallback path can't be asserted by date value (we don't pin Date.now in this
    // suite). Instead: ensure the call does not throw and that today's notes can still
    // be retrieved when the basename is unconventional and a note's `created` matches
    // the system "today". We construct that "today" from new Date() ourselves.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const todayStr = `${y}-${m}-${d}`;

    const registry = makeTestRegistry([
      {
        name: 'v',
        path: tmpDir,
        provider: dailyProvider('Daily/unusual-name.md'),
        reader: buildReader([
          { path: 'Notes/match.md', frontmatter: { created: todayStr, type: 'reflection' } },
          { path: 'Notes/old.md', frontmatter: { created: '2020-01-01', type: 'reflection' } },
        ]),
        graph: makeGraph(),
      },
    ]);
    const tool = buildReadDailyTool({ registry });

    const result = await tool.handler({});

    expect(result.notes_today.map((n) => n.path)).toEqual(['Notes/match.md']);
  });
});
