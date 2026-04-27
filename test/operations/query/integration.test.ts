import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runQueryNotes } from '../../../src/modules/operations/query/query-notes.js';
import { FsVaultReader } from '../../../src/modules/operations/vault-reader.js';

interface FixtureFile {
  path: string;
  body: string;
}

const fixture: FixtureFile[] = [
  // Projects (5)
  fileWithFm('Projects/alpha.md', {
    type: 'project',
    status: 'active',
    tags: ['ai', 'mcp'],
    priority: 5,
    created: '2026-01-15',
  }),
  fileWithFm('Projects/beta.md', {
    type: 'project',
    status: 'wip',
    tags: ['ai'],
    priority: 3,
    created: '2026-02-10',
  }),
  fileWithFm('Projects/gamma.md', {
    type: 'project',
    status: 'archived',
    tags: ['old'],
    priority: 1,
    created: '2025-12-01',
  }),
  fileWithFm('Projects/delta.md', {
    type: 'project',
    status: 'active',
    tags: ['mcp'],
    priority: 8,
    deadline: '2026-06-01',
    created: '2026-03-20',
  }),
  fileWithFm('Projects/epsilon.md', {
    type: 'project',
    status: 'active',
    tags: ['ai', 'agents'],
    priority: 4,
    created: '2026-04-01',
  }),

  // Tasks (6)
  fileWithFm('Tasks/t1.md', { type: 'task', status: 'todo', tags: ['mcp'] }),
  fileWithFm('Tasks/t2.md', { type: 'task', status: 'doing', tags: ['ai'] }),
  fileWithFm('Tasks/t3.md', { type: 'task', status: 'done', tags: [] }),
  fileWithFm('Tasks/t4.md', { type: 'task', status: 'todo' }), // no tags
  fileWithFm('Tasks/t5.md', {
    type: 'task',
    status: 'todo',
    tags: ['ai/ml'],
    deadline: '2026-05-01',
  }),
  fileWithFm('Tasks/sub/t6.md', {
    type: 'task',
    status: 'todo',
    tags: ['nested'],
  }),

  // Areas (3)
  fileWithFm('Areas/finance.md', { type: 'area', tags: ['money'] }),
  fileWithFm('Areas/health.md', { type: 'area', tags: ['health'] }),
  fileWithFm('Areas/learning.md', { type: 'area', tags: ['ai'] }),

  // Daily (3)
  fileWithFm('Daily/2026-04-25.md', { type: 'daily' }),
  fileWithFm('Daily/2026-04-26.md', { type: 'daily' }),
  fileWithFm('Daily/2026-04-27.md', { type: 'daily' }),

  // Misc — no frontmatter at all
  { path: 'Inbox/scratch.md', body: 'just a body, no yaml\n' },
  { path: 'Inbox/idea.md', body: 'another loose idea\n' },
];

function fileWithFm(p: string, fm: Record<string, unknown>): FixtureFile {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${formatYamlValue(v)}`)
    .join('\n');
  return { path: p, body: `---\n${yaml}\n---\n\n# ${p}\nbody\n` };
}

function formatYamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
  if (typeof v === 'string') return v;
  return String(v);
}

describe('query_notes integration (real FsVaultReader on disk)', () => {
  let vaultRoot: string;
  let reader: FsVaultReader;

  beforeAll(async () => {
    vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-query-it-'));
    for (const f of fixture) {
      const abs = path.join(vaultRoot, f.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.body);
    }
    reader = new FsVaultReader({ vaultRoot });
  });

  afterAll(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('simple property filter (active projects)', async () => {
    const out = await runQueryNotes(
      { filter: { 'frontmatter.type': 'project', 'frontmatter.status': 'active' } },
      reader,
    );
    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/delta.md',
      'Projects/epsilon.md',
    ]);
    expect(out.truncated).toBe(false);
  });

  it('tag + property combination (active projects with #ai)', async () => {
    const out = await runQueryNotes(
      {
        filter: {
          $and: [{ tags: 'ai' }, { 'frontmatter.status': 'active' }],
        },
      },
      reader,
    );
    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/epsilon.md',
    ]);
  });

  it('$or over multiple status variants', async () => {
    const out = await runQueryNotes(
      {
        filter: {
          $and: [
            { 'frontmatter.type': 'project' },
            {
              $or: [{ 'frontmatter.status': 'active' }, { 'frontmatter.status': 'wip' }],
            },
          ],
        },
      },
      reader,
    );
    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Projects/alpha.md',
      'Projects/beta.md',
      'Projects/delta.md',
      'Projects/epsilon.md',
    ]);
  });

  it('date $gte — projects created on or after 2026-02-01', async () => {
    const out = await runQueryNotes(
      {
        filter: {
          'frontmatter.type': 'project',
          'frontmatter.created': { $gte: '2026-02-01' },
        },
        sort: { field: 'frontmatter.created', order: 'asc' },
      },
      reader,
    );
    expect(out.results.map((r) => r.path)).toEqual([
      'Projects/beta.md',
      'Projects/delta.md',
      'Projects/epsilon.md',
    ]);
  });

  it('$exists true / false on frontmatter.deadline', async () => {
    const has = await runQueryNotes(
      { filter: { 'frontmatter.deadline': { $exists: true } } },
      reader,
    );
    expect(has.results.map((r) => r.path).sort()).toEqual(['Projects/delta.md', 'Tasks/t5.md']);

    const lacks = await runQueryNotes(
      {
        filter: {
          'frontmatter.type': 'task',
          'frontmatter.deadline': { $exists: false },
        },
      },
      reader,
    );
    expect(lacks.results.map((r) => r.path).sort()).toEqual([
      'Tasks/sub/t6.md',
      'Tasks/t1.md',
      'Tasks/t2.md',
      'Tasks/t3.md',
      'Tasks/t4.md',
    ]);
  });

  it('deeply nested $and / $or composition', async () => {
    const out = await runQueryNotes(
      {
        filter: {
          $and: [
            {
              $or: [{ 'frontmatter.type': 'project' }, { 'frontmatter.type': 'task' }],
            },
            {
              $or: [{ tags: 'mcp' }, { tags: 'agents' }],
            },
            { 'frontmatter.status': { $in: ['active', 'todo'] } },
          ],
        },
        sort: { field: 'path', order: 'asc' },
      },
      reader,
    );
    expect(out.results.map((r) => r.path)).toEqual([
      'Projects/alpha.md',
      'Projects/delta.md',
      'Projects/epsilon.md',
      'Tasks/t1.md',
    ]);
  });

  it('empty result is { results: [], count: 0, truncated: false }', async () => {
    const out = await runQueryNotes({ filter: { 'frontmatter.status': 'no-such-status' } }, reader);
    expect(out).toEqual({ results: [], count: 0, truncated: false });
  });

  it('path_prefix scopes the scan to a subtree', async () => {
    const out = await runQueryNotes(
      { filter: { 'frontmatter.type': 'task' }, path_prefix: 'Tasks' },
      reader,
    );
    expect(out.results.map((r) => r.path).sort()).toEqual([
      'Tasks/sub/t6.md',
      'Tasks/t1.md',
      'Tasks/t2.md',
      'Tasks/t3.md',
      'Tasks/t4.md',
      'Tasks/t5.md',
    ]);
  });

  it('include_content returns the body alongside frontmatter', async () => {
    const out = await runQueryNotes(
      {
        filter: { 'frontmatter.type': 'project', 'frontmatter.status': 'wip' },
        include_content: true,
      },
      reader,
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      path: 'Projects/beta.md',
      content: expect.stringContaining('# Projects/beta.md'),
    });
  });
});
