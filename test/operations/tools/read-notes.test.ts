import { describe, expect, it } from 'vitest';

import { buildReadNotesTool } from '../../../src/modules/operations/tools/read-notes.js';
import { makeReader } from './_helpers.js';

describe('operations.readNotes handler', () => {
  it('reads a single path with default fields', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['Folder/n.md'] });

    expect(result).toEqual({
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
      count: 1,
      errors: 0,
    });
  });

  it('dedupes paths preserving first-occurrence order', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: null, content: '' },
        { path: 'b.md', frontmatter: null, content: '' },
      ],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['a.md', 'b.md', 'a.md'] });

    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it("projects 'frontmatter' only when fields excludes 'content'", async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'body' }],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['a.md'], fields: ['frontmatter'] });

    expect(result.results[0]).toEqual({ path: 'a.md', frontmatter: { x: 1 } });
    expect((result.results[0] as { content?: string }).content).toBeUndefined();
  });

  it("projects 'content' only when fields excludes 'frontmatter'", async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'body' }],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['a.md'], fields: ['content'] });

    expect(result.results[0]).toEqual({ path: 'a.md', content: 'body' });
    expect((result.results[0] as { frontmatter?: unknown }).frontmatter).toBeUndefined();
  });

  it('rejects 0 paths with INVALID_ARGUMENT (top-level)', async () => {
    const tool = buildReadNotesTool({
      reader: makeReader(),
    });
    await expect(tool.handler({ paths: [] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects 51 paths with INVALID_ARGUMENT (top-level)', async () => {
    const tool = buildReadNotesTool({
      reader: makeReader(),
    });
    const paths = Array.from({ length: 51 }, (_, i) => `n${i}.md`);
    await expect(tool.handler({ paths })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects empty fields with INVALID_ARGUMENT (top-level)', async () => {
    const tool = buildReadNotesTool({
      reader: makeReader(),
    });
    await expect(tool.handler({ paths: ['a.md'], fields: [] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects unknown field with INVALID_ARGUMENT (top-level)', async () => {
    const tool = buildReadNotesTool({
      reader: makeReader(),
    });
    await expect(
      tool.handler({ paths: ['a.md'], fields: ['mtime' as unknown as 'frontmatter'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('produces per-item INVALID_ARGUMENT for traversal paths and reads the rest', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: null, content: 'a' }],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['a.md', '../etc/passwd'] });

    expect(result.count).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.results[0]).toMatchObject({ path: 'a.md' });
    expect(result.results[1]).toMatchObject({
      path: '../etc/passwd',
      error: { code: 'INVALID_ARGUMENT' },
    });
  });

  it('produces per-item INVALID_ARGUMENT for absolute paths', async () => {
    const reader = makeReader({ readNotes: async () => [] });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['/absolute.md'] });

    expect(result.results).toEqual([
      {
        path: '/absolute.md',
        error: expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      },
    ]);
    expect(result.errors).toBe(1);
  });

  it('passes through per-item NOT_FOUND from the reader', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: null, content: 'a' },
        { path: 'missing.md', error: { code: 'NOT_FOUND', message: 'Note not found: missing.md' } },
      ],
    });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({ paths: ['a.md', 'missing.md'] });

    expect(result.errors).toBe(1);
    expect(result.results[1]).toMatchObject({
      path: 'missing.md',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('replaces 8 read_property calls: 8 paths with fields=[frontmatter]', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `t${i}.md`,
      frontmatter: { status: i % 2 === 0 ? 'done' : 'todo' },
      content: 'body',
    }));
    const reader = makeReader({ readNotes: async () => items });
    const tool = buildReadNotesTool({ reader });

    const result = await tool.handler({
      paths: items.map((i) => i.path),
      fields: ['frontmatter'],
    });

    expect(result.count).toBe(8);
    expect(result.errors).toBe(0);
    expect(result.results.every((r) => 'frontmatter' in r && !('content' in r))).toBe(true);
  });
});
