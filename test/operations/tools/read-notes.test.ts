import { describe, expect, it } from 'vitest';

import { buildReadNotesTool } from '../../../src/modules/operations/tools/read-notes.js';
import { PREVIEW_CHAR_CAP, PREVIEW_MARKER } from '../../../src/modules/operations/preview-body.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool, expectToolError } from '../../_gate.js';
import type { ReadNotesResult } from '../../../src/modules/operations/types.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeReader, readerOverFiles } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

type ReadNotesOut = { vault: string } & ReadNotesResult;

function buildReg(reader: VaultReader = makeReader()) {
  return registerTool(buildReadNotesTool({ registry: makeTestRegistry([{ name: 'v', reader }]) }));
}

describe('operations.readNotes handler', () => {
  it('reads a single path with no content (default full) and includes vault', async () => {
    const reader = readerOverFiles({ 'Folder/n.md': '---\na: 1\n---\nbody' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['Folder/n.md'] });

    expect(result).toEqual({
      vault: 'v',
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body', lines: [4, 4] }],
      count: 1,
      errors: 0,
    });
    expect((result.results[0] as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it('accepts a single string for paths and returns identical shape to the array form', async () => {
    const reader = readerOverFiles({ 'Folder/n.md': '---\na: 1\n---\nbody' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'Folder/n.md' });

    expect(result).toEqual({
      vault: 'v',
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body', lines: [4, 4] }],
      count: 1,
      errors: 0,
    });
  });

  it('rejects an empty string for paths at the gate', async () => {
    await expect(callTool(buildReg(), { paths: '' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('dedupes paths preserving first-occurrence order', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: null, content: '' },
        { path: 'b.md', frontmatter: null, content: '' },
      ],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', 'b.md', 'a.md'],
    });

    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it("returns only { path, frontmatter } when content: 'frontmatter'", async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'body' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md'],
      content: 'frontmatter',
    });

    expect(result.results[0]).toEqual({ path: 'a.md', frontmatter: { x: 1 } });
    expect((result.results[0] as { content?: string }).content).toBeUndefined();
    expect((result.results[0] as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it('single path + no content defaults to full { path, frontmatter, content, lines }', async () => {
    const reader = readerOverFiles({ 'a.md': '---\nx: 1\n---\nfull body here' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['a.md'] });

    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'full body here',
      lines: [4, 4],
    });
  });

  it('two or more paths + no content default to preview (each item has truncated)', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: { x: 1 }, content: 'short a' },
        { path: 'b.md', frontmatter: { y: 2 }, content: 'short b' },
      ],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['a.md', 'b.md'] });

    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'short a',
      truncated: false,
    });
    expect(result.results[1]).toEqual({
      path: 'b.md',
      frontmatter: { y: 2 },
      content: 'short b',
      truncated: false,
    });
  });

  it('treats a duplicate single path as ONE distinct path → full', async () => {
    const reader = readerOverFiles({ 'a.md': '---\nx: 1\n---\nfull body' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['a.md', 'a.md'] });

    expect(result.count).toBe(1);
    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'full body',
      lines: [4, 4],
    });
  });

  it("content: 'full' on a multi-path call returns all full (override)", async () => {
    const reader = readerOverFiles({
      'a.md': '---\nx: 1\n---\nbody a',
      'b.md': '---\ny: 2\n---\nbody b',
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', 'b.md'],
      content: 'full',
    });

    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'body a',
      lines: [4, 4],
    });
    expect(result.results[1]).toEqual({
      path: 'b.md',
      frontmatter: { y: 2 },
      content: 'body b',
      lines: [4, 4],
    });
    expect((result.results[0] as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it("content: 'preview' on a single path returns preview (override)", async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'short body' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md'],
      content: 'preview',
    });

    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'short body',
      truncated: false,
    });
  });

  it("content: 'preview' with a short body keeps it intact and sets truncated: false", async () => {
    const shortBody = 'a'.repeat(PREVIEW_CHAR_CAP);
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: null, content: shortBody }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md'],
      content: 'preview',
    });

    expect(result.results[0]).toMatchObject({ content: shortBody, truncated: false });
  });

  it("content: 'preview' with a long body cuts it and sets truncated: true", async () => {
    const longBody = 'word '.repeat(PREVIEW_CHAR_CAP);
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: null, content: longBody }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md'],
      content: 'preview',
    });

    const item = result.results[0] as { content: string; truncated: boolean };
    expect(item.truncated).toBe(true);
    expect(item.content.length).toBeLessThan(longBody.length);
    expect(item.content.endsWith(PREVIEW_MARKER)).toBe(true);
  });

  it('rejects zero paths at the gate', async () => {
    await expect(callTool(buildReg(), { paths: [] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('rejects 51 paths at the gate', async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `n${i}.md`);
    await expect(callTool(buildReg(), { paths })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'paths' }] },
    });
  });

  it('rejects an invalid content value at the gate, naming the four modes', async () => {
    const err = await expectToolError(buildReg(), { paths: ['a.md'], content: 'none' });

    expect(err).toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'content' }] },
    });
    for (const mode of ['full', 'outline', 'preview', 'frontmatter']) {
      expect(err.message).toContain(mode);
    }
  });

  it('produces per-item INVALID_ARGUMENT for traversal paths and reads the rest', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: null, content: 'a' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', '../etc/passwd'],
    });

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

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['/absolute.md'] });

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

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', 'missing.md'],
    });

    expect(result.errors).toBe(1);
    expect(result.results[1]).toMatchObject({
      path: 'missing.md',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('rejects a legacy fields key as an unrecognized key', async () => {
    await expect(
      callTool(buildReg(), { paths: ['a.md'], fields: ['content'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('fields') }] },
    });
  });

  it("returns frontmatter only for 8 paths with content: 'frontmatter'", async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      path: `t${i}.md`,
      frontmatter: { status: i % 2 === 0 ? 'done' : 'todo' },
      content: 'body',
    }));
    const reader = makeReader({ readNotes: async () => items });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: items.map((i) => i.path),
      content: 'frontmatter',
    });

    expect(result.count).toBe(8);
    expect(result.errors).toBe(0);
    expect(
      result.results.every((r) => 'frontmatter' in r && !('content' in r) && !('truncated' in r)),
    ).toBe(true);
  });

  it('coerces a stringified paths array', async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: null, content: 'a' },
        { path: 'b.md', frontmatter: null, content: 'b' },
      ],
    });
    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: '["a.md","b.md"]',
    });

    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it('rejects a vault argument in single-vault mode', async () => {
    await expect(callTool(buildReg(), { paths: ['a.md'], vault: 'v' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
});

describe('operations.readNotes outline and body spans', () => {
  // Lines: 1-3 frontmatter, 4 blank, 5 intro, 6 `# Top`, 7 `## Inner`, 8 `x`.
  const NOTE = '---\na: 1\n---\n\nintro\n# Top\n## Inner\nx\n';
  const ENTRIES = [
    { heading: 'Top', level: 1, lines: [6, 8] },
    { heading: 'Inner', level: 2, lines: [7, 8] },
  ];

  it("content: 'outline' returns the body span, the preamble and the heading blocks", async () => {
    const reader = readerOverFiles({ 'n.md': NOTE });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: 'n.md',
      content: 'outline',
    });

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { a: 1 }, lines: [4, 8], preamble: [4, 5], outline: ENTRIES },
    ]);
  });

  it("content: 'outline' carries no preamble key when the text before the first heading is blank", async () => {
    const reader = readerOverFiles({ 'n.md': '---\na: 1\n---\n\n   \n# Top\nx\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: 'n.md',
      content: 'outline',
    });

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        frontmatter: { a: 1 },
        lines: [4, 7],
        outline: [{ heading: 'Top', level: 1, lines: [6, 7] }],
      },
    ]);
  });

  it('a bare full read echoes the body span next to the unchanged content', async () => {
    const reader = readerOverFiles({ 'n.md': NOTE });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'n.md' });

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        frontmatter: { a: 1 },
        content: '\nintro\n# Top\n## Inner\nx\n',
        lines: [4, 8],
      },
    ]);
  });

  it('a full read of a note with no frontmatter spans the whole file', async () => {
    const reader = readerOverFiles({ 'n.md': '# Top\nx\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'n.md' });

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: null, content: '# Top\nx\n', lines: [1, 2] },
    ]);
  });

  describe('malformed frontmatter YAML', () => {
    // Lines: 1-3 an unparseable fence, 4 `# Top`, 5 `x`.
    const MALFORMED = '---\na: [unclosed\n---\n# Top\nx\n';

    it('a full read returns the raw file and spans every line of it', async () => {
      const reader = readerOverFiles({ 'n.md': MALFORMED });

      const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'n.md' });

      expect(result.results).toStrictEqual([
        { path: 'n.md', frontmatter: null, content: MALFORMED, lines: [1, 5] },
      ]);
    });

    it("content: 'outline' still lists the chunker's heading blocks", async () => {
      const reader = readerOverFiles({ 'n.md': MALFORMED });

      const result = await callTool<ReadNotesOut>(buildReg(reader), {
        paths: 'n.md',
        content: 'outline',
      });

      expect(result.results).toStrictEqual([
        {
          path: 'n.md',
          frontmatter: null,
          lines: [4, 5],
          outline: [{ heading: 'Top', level: 1, lines: [4, 5] }],
        },
      ]);
    });
  });

  it("content: 'outline' on a 133-heading note collapses and carries collapsed: true", async () => {
    const lines = ['# Title'];
    for (let g = 0; g < 12; g++) {
      lines.push(`## G${g}`);
      for (let c = 0; c < 10; c++) lines.push(`### G${g}C${c}`);
    }
    const reader = readerOverFiles({ 'big.md': lines.join('\n') + '\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: 'big.md',
      content: 'outline',
    });

    const item = result.results[0] as { outline: { level: number; hidden?: number }[] };
    expect(result.results[0]).toHaveProperty('collapsed', true);
    expect(item.outline).toHaveLength(13);
    expect(item.outline[0].hidden).toBeUndefined();
    expect(item.outline.slice(1).every((e) => e.level === 2 && e.hidden === 10)).toBe(true);
  });

  it("content: 'outline' on a frontmatter-only note has no lines, no preamble and an empty outline", async () => {
    const reader = readerOverFiles({ 'n.md': '---\na: 1\n---\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: 'n.md',
      content: 'outline',
    });

    expect(result.results).toStrictEqual([{ path: 'n.md', frontmatter: { a: 1 }, outline: [] }]);
  });

  describe('an empty note', () => {
    it("content: 'outline' has no lines, no preamble and an empty outline", async () => {
      const reader = readerOverFiles({ 'e.md': '' });

      const result = await callTool<ReadNotesOut>(buildReg(reader), {
        paths: 'e.md',
        content: 'outline',
      });

      expect(result.results).toStrictEqual([{ path: 'e.md', frontmatter: null, outline: [] }]);
    });

    it('a full read returns the empty content and no lines', async () => {
      const reader = readerOverFiles({ 'e.md': '' });

      const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'e.md' });

      expect(result.results).toStrictEqual([{ path: 'e.md', frontmatter: null, content: '' }]);
    });
  });

  it('a full read of a frontmatter-only note returns the empty body and no lines', async () => {
    const reader = readerOverFiles({ 'n.md': '---\na: 1\n---\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'n.md' });

    expect(result.results).toStrictEqual([{ path: 'n.md', frontmatter: { a: 1 }, content: '' }]);
  });

  it("content: 'outline' lists every item of a multi-path call", async () => {
    const reader = readerOverFiles({ 'a.md': NOTE, 'b.md': '# Solo\n' });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', 'b.md', 'missing.md'],
      content: 'outline',
    });

    expect(result.results).toStrictEqual([
      { path: 'a.md', frontmatter: { a: 1 }, lines: [4, 8], preamble: [4, 5], outline: ENTRIES },
      {
        path: 'b.md',
        frontmatter: null,
        lines: [1, 1],
        outline: [{ heading: 'Solo', level: 1, lines: [1, 1] }],
      },
      { path: 'missing.md', error: expect.objectContaining({ code: 'NOT_FOUND' }) },
    ]);
    expect(result.errors).toBe(1);
  });
});
