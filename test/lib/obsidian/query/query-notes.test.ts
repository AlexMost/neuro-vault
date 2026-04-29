import { describe, expect, it, vi } from 'vitest';

import { ToolHandlerError } from '../../../../src/lib/tool-response.js';
import { runQueryNotes } from '../../../../src/lib/obsidian/query/query-notes.js';
import {
  ScanPathNotFoundError,
  type ReadNotesItem,
  type VaultReader,
} from '../../../../src/lib/obsidian/vault-reader.js';

interface FakeNote {
  path: string;
  frontmatter: Record<string, unknown>;
  content?: string;
}

function buildReader(notes: FakeNote[]): VaultReader {
  return {
    scan: vi.fn(async () => notes.map((n) => n.path)),
    readNotes: vi.fn(async ({ paths }: { paths: string[] }): Promise<ReadNotesItem[]> => {
      const byPath = new Map(notes.map((n) => [n.path, n]));
      return paths.map((p) => {
        const note = byPath.get(p);
        if (!note) {
          return {
            path: p,
            error: { code: 'NOT_FOUND' as const, message: 'missing' },
          };
        }
        return {
          path: note.path,
          frontmatter: note.frontmatter,
          content: note.content ?? '',
        };
      });
    }),
  };
}

describe('runQueryNotes', () => {
  const fixture: FakeNote[] = [
    {
      path: 'Projects/alpha.md',
      frontmatter: { type: 'project', status: 'active', tags: ['ai', 'mcp'], priority: 5 },
      content: 'alpha body',
    },
    {
      path: 'Projects/beta.md',
      frontmatter: { type: 'project', status: 'wip', tags: ['ai'], priority: 3 },
      content: 'beta body',
    },
    {
      path: 'Tasks/t1.md',
      frontmatter: { type: 'task', status: 'todo', tags: ['mcp'] },
      content: 't1 body',
    },
    {
      path: 'Areas/finance.md',
      frontmatter: { type: 'area' },
      content: 'finance body',
    },
  ];

  it('filters by simple frontmatter equality', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes({ filter: { 'frontmatter.status': 'active' } }, reader);

    expect(out.results.map((r) => r.path)).toEqual(['Projects/alpha.md']);
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('filters by tag (exact, sift-default)', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes({ filter: { tags: 'ai' } }, reader);

    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/beta.md',
    ]);
  });

  it('filters with $or composition', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes(
      {
        filter: {
          $or: [{ 'frontmatter.status': 'active' }, { 'frontmatter.status': 'wip' }],
        },
      },
      reader,
    );

    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/beta.md',
    ]);
  });

  it('supports $exists', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes(
      { filter: { 'frontmatter.priority': { $exists: true } } },
      reader,
    );

    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/beta.md',
    ]);
  });

  it('omits content by default and includes it when include_content is true', async () => {
    const reader = buildReader(fixture);

    const without = await runQueryNotes({ filter: { 'frontmatter.status': 'active' } }, reader);
    expect(without.results[0]).not.toHaveProperty('content');
    expect(reader.readNotes).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['frontmatter'] }),
    );

    const reader2 = buildReader(fixture);
    const withContent = await runQueryNotes(
      { filter: { 'frontmatter.status': 'active' }, include_content: true },
      reader2,
    );
    expect(withContent.results[0]).toMatchObject({
      path: 'Projects/alpha.md',
      content: 'alpha body',
    });
    expect(reader2.readNotes).toHaveBeenCalledWith(
      expect.objectContaining({ fields: ['frontmatter', 'content'] }),
    );
  });

  it('respects limit and sets truncated when matched > limit', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes(
      {
        filter: { 'frontmatter.type': 'project' },
        limit: 1,
        sort: { field: 'path', order: 'asc' },
      },
      reader,
    );

    expect(out.results.map((r) => r.path)).toEqual(['Projects/alpha.md']);
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(true);
  });

  it('truncated is false when matched <= limit', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes(
      { filter: { 'frontmatter.type': 'project' }, limit: 5 },
      reader,
    );

    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('sorts by frontmatter field desc', async () => {
    const reader = buildReader(fixture);

    const out = await runQueryNotes(
      {
        filter: { 'frontmatter.type': 'project' },
        sort: { field: 'frontmatter.priority', order: 'desc' },
      },
      reader,
    );

    expect(out.results.map((r) => r.path)).toEqual(['Projects/alpha.md', 'Projects/beta.md']);
  });

  it('rejects an absolute path_prefix with INVALID_PARAMS', async () => {
    const reader = buildReader(fixture);

    await expect(runQueryNotes({ filter: {}, path_prefix: '/abs' }, reader)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('rejects "..", "limit" out of range, bad sort.order with INVALID_PARAMS', async () => {
    const reader = buildReader(fixture);

    await expect(
      runQueryNotes({ filter: {}, path_prefix: '../escape' }, reader),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(runQueryNotes({ filter: {}, limit: 0 }, reader)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(runQueryNotes({ filter: {}, limit: 5000 }, reader)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    await expect(
      runQueryNotes({ filter: {}, sort: { field: 'path', order: 'sideways' as 'asc' } }, reader),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('translates ScanPathNotFoundError into PATH_NOT_FOUND', async () => {
    const reader: VaultReader = {
      scan: vi.fn(async () => {
        throw new ScanPathNotFoundError('Nope');
      }),
      readNotes: vi.fn(),
    };

    const err = await runQueryNotes({ filter: {}, path_prefix: 'Nope' }, reader).catch((e) => e);
    expect(err).toBeInstanceOf(ToolHandlerError);
    expect(err.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects non-whitelisted operators with INVALID_FILTER', async () => {
    const reader = buildReader(fixture);

    await expect(runQueryNotes({ filter: { $where: 'true' } }, reader)).rejects.toMatchObject({
      code: 'INVALID_FILTER',
    });
  });

  it('drops per-item reader errors silently', async () => {
    const reader: VaultReader = {
      scan: vi.fn(async () => ['a.md', 'b.md', 'c.md']),
      readNotes: vi.fn(
        async (): Promise<ReadNotesItem[]> => [
          { path: 'a.md', frontmatter: { status: 'active' }, content: '' },
          { path: 'b.md', error: { code: 'NOT_FOUND' as const, message: 'gone' } },
          { path: 'c.md', frontmatter: { status: 'active' }, content: '' },
        ],
      ),
    };

    const out = await runQueryNotes({ filter: { 'frontmatter.status': 'active' } }, reader);

    expect(out.results.map((r) => r.path).sort()).toEqual(['a.md', 'c.md']);
    expect(out.count).toBe(2);
    expect(out.truncated).toBe(false);
  });

  it('returns empty result for empty scan', async () => {
    const reader = buildReader([]);

    const out = await runQueryNotes({ filter: { tags: 'ai' } }, reader);

    expect(out).toEqual({ results: [], count: 0, truncated: false });
  });

  it('early-exits when matches > limit and sort allows it (no sort)', async () => {
    // 200 paths, all matching — we expect to stop reading after enough matches.
    const notes: FakeNote[] = Array.from({ length: 200 }, (_, i) => ({
      path: `n${String(i).padStart(4, '0')}.md`,
      frontmatter: { type: 'project' },
      content: '',
    }));
    const reader = buildReader(notes);

    const out = await runQueryNotes(
      { filter: { 'frontmatter.type': 'project' }, limit: 5 },
      reader,
    );

    // Top-5 by scan order = first 5 paths.
    expect(out.results.map((r) => r.path)).toEqual([
      'n0000.md',
      'n0001.md',
      'n0002.md',
      'n0003.md',
      'n0004.md',
    ]);
    expect(out.truncated).toBe(true);
    // Should not have read the entire 200 — at most a couple of batches.
    const totalPathsRead = (reader.readNotes as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (acc, [arg]) => acc + (arg.paths as string[]).length,
      0,
    );
    expect(totalPathsRead).toBeLessThan(notes.length);
  });

  it('does NOT early-exit when sort is by frontmatter (must scan all)', async () => {
    const notes: FakeNote[] = Array.from({ length: 100 }, (_, i) => ({
      path: `n${String(i).padStart(3, '0')}.md`,
      frontmatter: { type: 'project', priority: i },
      content: '',
    }));
    const reader = buildReader(notes);

    const out = await runQueryNotes(
      {
        filter: { 'frontmatter.type': 'project' },
        sort: { field: 'frontmatter.priority', order: 'desc' },
        limit: 3,
      },
      reader,
    );

    expect(out.results.map((r) => r.path)).toEqual(['n099.md', 'n098.md', 'n097.md']);
    expect(out.truncated).toBe(true);
    const totalPathsRead = (reader.readNotes as ReturnType<typeof vi.fn>).mock.calls.reduce(
      (acc, [arg]) => acc + (arg.paths as string[]).length,
      0,
    );
    expect(totalPathsRead).toBe(notes.length);
  });

  it('reads in bounded batches rather than one mega-call', async () => {
    const notes: FakeNote[] = Array.from({ length: 80 }, (_, i) => ({
      path: `n${String(i).padStart(3, '0')}.md`,
      frontmatter: { type: 'project' },
      content: '',
    }));
    const reader = buildReader(notes);

    await runQueryNotes(
      {
        filter: { 'frontmatter.type': 'nope' }, // no matches → forces full scan
      },
      reader,
    );

    const calls = (reader.readNotes as ReturnType<typeof vi.fn>).mock.calls;
    // No single call should request more than the batch budget (32).
    for (const [arg] of calls) {
      expect((arg.paths as string[]).length).toBeLessThanOrEqual(32);
    }
    // 80 paths / 32 = 3 batches.
    expect(calls.length).toBe(3);
  });
});
