import { describe, expect, it, vi } from 'vitest';

import { buildReadNotesTool } from '../../../src/modules/operations/tools/read-notes.js';
import { PREVIEW_CHAR_CAP, PREVIEW_MARKER } from '../../../src/modules/operations/preview-body.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool, expectToolError } from '../../_gate.js';
import type { ReadNotesResult } from '../../../src/modules/operations/types.js';
import type { ReadNotesItem, VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
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

describe('operations.readNotes selector items at the gate', () => {
  /** `a.md`: `# Top` on line 1, then `l2` .. `l25`. `b.md`: four lines. */
  const FILES = {
    'a.md': ['# Top', ...Array.from({ length: 24 }, (_, i) => `l${i + 2}`)].join('\n') + '\n',
    'b.md': 'b1\nb2\nb3\nb4\n',
  };

  it('reads a stringified mixed array as two items', async () => {
    const reader = readerOverFiles(FILES);

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: '["a.md",{"path":"b.md","lines":[3,9]}]',
    });

    expect(result.count).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.results.map((r) => r.path)).toStrictEqual(['a.md', 'b.md']);
    expect(result.results[1]).toHaveProperty('lines', [3, 4]);
  });

  it("accepts numeric strings in a lines pair: lines: ['10', '20']", async () => {
    const reader = readerOverFiles(FILES);

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: [{ path: 'a.md', lines: ['10', '20'] }],
    });

    expect(result.count).toBe(1);
    expect(result.results[0]).toMatchObject({
      path: 'a.md',
      content: Array.from({ length: 11 }, (_, i) => `l${i + 10}`).join('\n'),
      lines: [10, 20],
    });
  });

  it.each([[''], ['  ']])(
    'rejects heading: %j with INVALID_PARAMS naming { path, lines }',
    async (heading) => {
      const err = await expectToolError(buildReg(), { paths: [{ path: 'a.md', heading }] });

      expect(err.code).toBe('INVALID_PARAMS');
      expect(err.message).toContain('{ path, lines');
    },
  );

  it.each([
    ['inverted', [20, 10]],
    ['one number', [10]],
    ['three numbers', [10, 20, 30]],
    ['a fraction', [1.5, 3]],
    ['a zero start', [0, 3]],
  ])('rejects a lines value that is %s with INVALID_PARAMS', async (_label, lines) => {
    const err = await expectToolError(buildReg(), { paths: [{ path: 'a.md', lines }] });

    expect(err.code).toBe('INVALID_PARAMS');
  });

  // The two cases zod reports as a specific issue: they prove the object item
  // reached the lines schema, rather than being rejected wholesale.
  it.each([
    [[20, 10], 'paths.0.lines: lines: start must not exceed end'],
    [[0, 3], 'paths.0.lines.0: Too small: expected number to be >=1'],
  ])('reports lines %j at its own issue path', async (lines, message) => {
    const err = await expectToolError(buildReg(), { paths: [{ path: 'a.md', lines }] });

    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toBe(message);
  });

  it('rejects an unrecognized key on an item with INVALID_PARAMS', async () => {
    const err = await expectToolError(buildReg(), {
      paths: [{ path: 'a.md', content: 'full' }],
    });

    expect(err.code).toBe('INVALID_PARAMS');
  });

  it('fails the call with INVALID_ARGUMENT for heading + lines on one item, reading nothing', async () => {
    const readNotes = vi.fn(async () => [] as ReadNotesItem[]);
    const reader = makeReader({ readNotes });

    const err = await expectToolError(buildReg(reader), {
      paths: ['b.md', { path: 'a.md', heading: 'Top', lines: [3, 9] }],
    });

    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toBe(
      'an item names one selection: pass either heading or lines, not both (a.md)',
    );
    expect(readNotes).not.toHaveBeenCalled();
  });

  it('accepts a one-line range [n, n]', async () => {
    const reader = readerOverFiles(FILES);

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: [{ path: 'a.md', lines: [2, 2] }],
    });

    expect(result.count).toBe(1);
  });
});

describe('operations.readNotes request items', () => {
  const FILES = {
    'a.md': '---\nx: 1\n---\n# Top\nalpha\n',
    'b.md': '---\ny: 2\n---\n# Other\nbeta\n',
  };

  it('{ path } with no selector returns exactly what the bare path does', async () => {
    const asObject = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: [{ path: 'a.md' }],
    });
    const asString = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md'],
    });

    expect(asObject).toStrictEqual(asString);
  });

  it('a path and the same path with a selector are two items', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: 'a.md', lines: [1, 2] }],
    });

    expect(result.count).toBe(2);
    expect(result.results.map((r) => r.path)).toStrictEqual(['a.md', 'a.md']);
  });

  it('the same selector item twice is one item', async () => {
    const item = { path: 'a.md', heading: 'Top' };

    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: [item, { ...item }],
    });

    expect(result.count).toBe(1);
  });

  it('{ path } and the bare path are one item', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: 'a.md' }],
    });

    expect(result.count).toBe(1);
    expect(result.results[0]).toHaveProperty('lines');
    expect(result.results[0]).not.toHaveProperty('truncated');
  });

  it('defaults a bare path to preview and a selector item to full in one call', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: 'b.md', lines: [5, 6] }],
    });

    expect(result.results[0]).toHaveProperty('truncated', false);
    expect(result.results[0]).not.toHaveProperty('lines');
    expect(result.results[1]).toHaveProperty('content');
    expect(result.results[1]).not.toHaveProperty('truncated');
  });

  it('counts a selector item toward the bare-path default', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: 'a.md', heading: 'Top' }],
    });

    expect(result.count).toBe(2);
    expect(result.results[0]).toHaveProperty('truncated', false);
    expect(result.results[1]).not.toHaveProperty('truncated');
  });

  it('an explicit content applies to selector items too', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: 'b.md', lines: [5, 6] }],
      content: 'frontmatter',
    });

    expect(result.results).toStrictEqual([
      { path: 'a.md', frontmatter: { x: 1 } },
      { path: 'b.md', frontmatter: { y: 2 } },
    ]);
  });

  it('an unsafe path on a selector item is a per-item INVALID_ARGUMENT beside a valid item', async () => {
    const result = await callTool<ReadNotesOut>(buildReg(readerOverFiles(FILES)), {
      paths: ['a.md', { path: '../x.md', lines: [1, 2] }],
    });

    expect(result.count).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.results[0]).toMatchObject({ path: 'a.md', frontmatter: { x: 1 } });
    expect(result.results[1]).toStrictEqual({
      path: '../x.md',
      error: { code: 'INVALID_ARGUMENT', message: expect.any(String) as string },
    });
  });

  it('reads a note named by several items once', async () => {
    const reader = readerOverFiles(FILES);
    const spy = vi.spyOn(reader, 'readNotes');

    await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', { path: 'a.md', lines: [4, 5] }, { path: 'a.md', heading: 'Top' }, 'b.md'],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].paths).toStrictEqual(['a.md', 'b.md']);
  });
});

describe('operations.readNotes lines selections', () => {
  /** A 40-line note: lines 1-4 frontmatter, then `line 5` .. `line 40`. */
  const FORTY = (() => {
    const body = Array.from({ length: 36 }, (_, i) => `line ${i + 5}`);
    return ['---', 'a: 1', 'b: 2', '---', ...body].join('\n') + '\n';
  })();
  const bodyLines = (s: number, e: number) =>
    Array.from({ length: e - s + 1 }, (_, i) => `line ${s + i}`).join('\n');

  const read = (paths: unknown, files: Record<string, string> = { 'n.md': FORTY }) =>
    callTool<ReadNotesOut>(buildReg(readerOverFiles(files)), { paths });

  it('clips a range overlapping the frontmatter and echoes the clipped span', async () => {
    const result = await read([{ path: 'n.md', lines: [2, 9] }]);

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { a: 1, b: 2 }, content: bodyLines(5, 9), lines: [5, 9] },
    ]);
  });

  it('clips a range past the end to the last line', async () => {
    const result = await read([{ path: 'n.md', lines: [30, 45] }]);

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { a: 1, b: 2 }, content: bodyLines(30, 40), lines: [30, 40] },
    ]);
  });

  it('reads a one-line range', async () => {
    const result = await read([{ path: 'n.md', lines: [7, 7] }]);

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { a: 1, b: 2 }, content: 'line 7', lines: [7, 7] },
    ]);
  });

  it('returns the lines verbatim, blank lines and markup included', async () => {
    const note = '---\nx: 1\n---\n# Top\n\n  - *item*  \n\n## Sub\ntail\n';

    const result = await read([{ path: 'n.md', lines: [4, 7] }], { 'n.md': note });

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { x: 1 }, content: '# Top\n\n  - *item*  \n', lines: [4, 7] },
    ]);
  });

  it('a range inside the frontmatter is a LINES_OUT_OF_RANGE miss with the body lines', async () => {
    const result = await read([{ path: 'n.md', lines: [1, 3] }]);

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        error: {
          code: 'LINES_OUT_OF_RANGE',
          message:
            "lines 1–3 of n.md lie in the frontmatter (body: lines 5–40); read the frontmatter with content: 'frontmatter', or a range inside the body",
        },
        lines: [5, 40],
      },
    ]);
    expect(result.errors).toBe(1);
  });

  it('a range past the end is the same miss, its message naming the body span', async () => {
    const result = await read([{ path: 'n.md', lines: [50, 60] }]);

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        error: {
          code: 'LINES_OUT_OF_RANGE',
          message: expect.stringMatching(/body: lines 5–40/) as string,
        },
        lines: [5, 40],
      },
    ]);
  });

  it('a range on a frontmatter-only note is a miss with no lines key', async () => {
    const result = await read([{ path: 'n.md', lines: [1, 1] }], { 'n.md': '---\na: 1\n---\n' });

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        error: { code: 'LINES_OUT_OF_RANGE', message: expect.any(String) as string },
      },
    ]);
  });

  it('a range on an empty note is a miss with no lines key', async () => {
    const result = await read([{ path: 'e.md', lines: [1, 1] }], { 'e.md': '' });

    expect(result.results).toStrictEqual([
      {
        path: 'e.md',
        error: { code: 'LINES_OUT_OF_RANGE', message: expect.any(String) as string },
      },
    ]);
  });

  it('a miss counts in errors and leaves the other items untouched', async () => {
    const result = await read([
      'n.md',
      { path: 'n.md', lines: [50, 60] },
      { path: 'n.md', lines: [5, 6] },
    ]);

    expect(result.count).toBe(3);
    expect(result.errors).toBe(1);
    expect(result.results[0]).toHaveProperty('truncated', false);
    expect(result.results[1]).toHaveProperty('error.code', 'LINES_OUT_OF_RANGE');
    expect(result.results[2]).toStrictEqual({
      path: 'n.md',
      frontmatter: { a: 1, b: 2 },
      content: bodyLines(5, 6),
      lines: [5, 6],
    });
  });

  it('two ranges of one note each return their own text', async () => {
    const result = await read([
      { path: 'n.md', lines: [10, 12] },
      { path: 'n.md', lines: [20, 21] },
    ]);

    expect(result.results.map((r) => ('content' in r ? r.content : null))).toStrictEqual([
      bodyLines(10, 12),
      bodyLines(20, 21),
    ]);
  });

  it('a CRLF note returns its range with interior CRLF kept and no dangling \\r', async () => {
    const crlf = '---\r\nx: 1\r\n---\r\none\r\ntwo\r\nthree\r\n';

    const result = await read([{ path: 'n.md', lines: [4, 5] }], { 'n.md': crlf });

    expect(result.results).toStrictEqual([
      { path: 'n.md', frontmatter: { x: 1 }, content: 'one\r\ntwo', lines: [4, 5] },
    ]);
  });
});

describe('operations.readNotes heading selections', () => {
  /**
   * Lines: 1-3 frontmatter, 4 `# Title`, 5 intro, 6 blank, 7 `## Progress`, 8 text,
   * 9 `### Week 1`, 10-40 filler, 41 `## **Open** questions`, 42 text.
   */
  const NOTE_LINES = [
    '---',
    'a: 1',
    '---',
    '# Title',
    'intro',
    '',
    '## Progress',
    'started',
    '### Week 1',
    ...Array.from({ length: 31 }, (_, i) => `w ${i + 10}`),
    '## **Open** questions',
    'q',
  ];
  const NOTE = NOTE_LINES.join('\n') + '\n';
  const text = (s: number, e: number) => NOTE_LINES.slice(s - 1, e).join('\n');
  const OUTLINE = [
    { heading: 'Title', level: 1, lines: [4, 42] },
    { heading: 'Progress', level: 2, lines: [7, 40] },
    { heading: 'Week 1', level: 3, lines: [9, 40] },
    { heading: '**Open** questions', level: 2, lines: [41, 42] },
  ];

  const read = (paths: unknown, files: Record<string, string> = { 'n.md': NOTE }) =>
    callTool<ReadNotesOut>(buildReg(readerOverFiles(files)), { paths });

  it('an exact heading name reads its whole block, sub-headings included', async () => {
    const result = await read([{ path: 'n.md', heading: 'Progress' }]);

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        frontmatter: { a: 1 },
        content: text(7, 40),
        lines: [7, 40],
        heading: 'Progress',
        level: 2,
      },
    ]);
    expect((result.results[0] as { content: string }).content).toContain('### Week 1');
  });

  it('a heading read returns the same text and lines as the range of its block', async () => {
    const result = await read([
      { path: 'n.md', heading: 'Progress' },
      { path: 'n.md', lines: [7, 40] },
    ]);

    const [byName, byLines] = result.results as { content: string; lines: number[] }[];
    expect(byName.content).toBe(byLines.content);
    expect(byName.lines).toStrictEqual(byLines.lines);
  });

  it('a normalized name resolves to the one block and echoes its heading name', async () => {
    const result = await read([{ path: 'n.md', heading: 'open questions' }]);

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        frontmatter: { a: 1 },
        content: text(41, 42),
        lines: [41, 42],
        heading: '**Open** questions',
        level: 2,
      },
    ]);
  });

  it('a name with its leading #s resolves to the heading', async () => {
    const result = await read([{ path: 'n.md', heading: '## Progress' }]);

    expect(result.results[0]).toMatchObject({ heading: 'Progress', lines: [7, 40] });
  });

  it('a name matches the display text of a wikilink heading', async () => {
    const result = await read([{ path: 'w.md', heading: 'Alpha' }], {
      'w.md': '# Top\n## [[notes/alpha|Alpha]]\nx\n',
    });

    expect(result.results).toStrictEqual([
      {
        path: 'w.md',
        frontmatter: null,
        content: '## [[notes/alpha|Alpha]]\nx',
        lines: [2, 3],
        heading: '[[notes/alpha|Alpha]]',
        level: 2,
      },
    ]);
  });

  it('case folding in the fallback covers non-Latin names', async () => {
    const result = await read([{ path: 'u.md', heading: 'нотатки зустрічі' }], {
      'u.md': '# Тема\n## Нотатки зустрічі\nтекст\n',
    });

    expect(result.results[0]).toMatchObject({
      heading: 'Нотатки зустрічі',
      level: 2,
      lines: [2, 3],
      content: '## Нотатки зустрічі\nтекст',
    });
  });

  it('a sibling duplicate is addressed by its [n] suffix', async () => {
    const result = await read([{ path: 's.md', heading: 'Notes[2]' }], {
      's.md': '# Day\n## Notes\nfirst\n## Notes\nsecond\n',
    });

    expect(result.results).toStrictEqual([
      {
        path: 's.md',
        frontmatter: null,
        content: '## Notes\nsecond',
        lines: [4, 5],
        heading: 'Notes[2]',
        level: 2,
      },
    ]);
  });

  it('a prefix of a heading name is HEADING_NOT_FOUND', async () => {
    const result = await read([{ path: 'd.md', heading: '2026-01' }], {
      'd.md': '## 2026-01-15 standup\nx\n',
    });

    expect(result.results[0]).toHaveProperty('error.code', 'HEADING_NOT_FOUND');
  });

  it('HEADING_NOT_FOUND carries the body lines and the outline, and no frontmatter', async () => {
    const result = await read([{ path: 'n.md', heading: 'Progres' }]);

    expect(result.results).toStrictEqual([
      {
        path: 'n.md',
        error: {
          code: 'HEADING_NOT_FOUND',
          message:
            'no heading block of n.md is named "Progres", exactly or ignoring case and markup; retry with a heading name from outline',
        },
        lines: [4, 42],
        outline: OUTLINE,
      },
    ]);
    expect(result.errors).toBe(1);
  });

  it('HEADING_NOT_FOUND on a large note carries the collapsed outline and collapsed: true', async () => {
    const lines = ['# Title'];
    for (let g = 0; g < 12; g++) {
      lines.push(`## G${g}`);
      for (let c = 0; c < 10; c++) lines.push(`### G${g}C${c}`);
    }
    const files = { 'big.md': lines.join('\n') + '\n' };

    const result = await read([{ path: 'big.md', heading: 'Missing' }], files);

    const item = result.results[0] as { outline: { level: number; hidden?: number }[] };
    expect(result.results[0]).toHaveProperty('error.code', 'HEADING_NOT_FOUND');
    expect(result.results[0]).toHaveProperty('lines', [1, 133]);
    expect(result.results[0]).toHaveProperty('collapsed', true);
    expect(result.results[0]).not.toHaveProperty('frontmatter');
    expect(item.outline).toHaveLength(13);
    expect(item.outline.slice(1).every((e) => e.level === 2 && e.hidden === 10)).toBe(true);
  });

  it('a heading hidden by a collapsed outline is still readable by name', async () => {
    const lines = ['# Title'];
    for (let g = 0; g < 12; g++) {
      lines.push(`## G${g}`);
      for (let c = 0; c < 10; c++) lines.push(`### G${g}C${c}`);
    }

    const result = await read([{ path: 'big.md', heading: 'G3C4' }], {
      'big.md': lines.join('\n') + '\n',
    });

    expect(result.results[0]).toMatchObject({ heading: 'G3C4', level: 3, content: '### G3C4' });
  });

  it('HEADING_NOT_FOUND on a frontmatter-only note carries an empty outline and no lines', async () => {
    const result = await read([{ path: 'f.md', heading: 'Notes' }], { 'f.md': '---\na: 1\n---\n' });

    expect(result.results).toStrictEqual([
      {
        path: 'f.md',
        error: { code: 'HEADING_NOT_FOUND', message: expect.any(String) as string },
        outline: [],
      },
    ]);
  });

  it('a cross-parent duplicate is AMBIGUOUS_MATCH listing both blocks', async () => {
    const result = await read([{ path: 'x.md', heading: 'Notes' }], {
      'x.md': '# A\n### Notes\na\n# B\n### Notes\nb\n',
    });

    expect(result.results).toStrictEqual([
      {
        path: 'x.md',
        error: {
          code: 'AMBIGUOUS_MATCH',
          message: expect.stringMatching(/\{ path, lines/) as string,
        },
        matches: [
          { heading: 'Notes', level: 3, lines: [2, 3] },
          { heading: 'Notes', level: 3, lines: [5, 6] },
        ],
      },
    ]);
    expect(result.errors).toBe(1);
  });

  it('a normalized fallback hitting two blocks is AMBIGUOUS_MATCH', async () => {
    const result = await read([{ path: 'p.md', heading: 'PLAN' }], {
      'p.md': '## Plan\na\n## plan\nb\n',
    });

    expect(result.results[0]).toHaveProperty('error.code', 'AMBIGUOUS_MATCH');
    expect(result.results[0]).toHaveProperty('matches', [
      { heading: 'Plan', level: 2, lines: [1, 2] },
      { heading: 'plan', level: 2, lines: [3, 4] },
    ]);
  });

  it('an exact match wins over the normalized ones', async () => {
    const result = await read([{ path: 'p.md', heading: 'plan' }], {
      'p.md': '## Plan\na\n## plan\nb\n',
    });

    expect(result.results).toStrictEqual([
      {
        path: 'p.md',
        frontmatter: null,
        content: '## plan\nb',
        lines: [3, 4],
        heading: 'plan',
        level: 2,
      },
    ]);
  });

  it('a heading miss does not fail the other items', async () => {
    const result = await read(['n.md', { path: 'n.md', heading: 'Missing' }]);

    expect(result.count).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.results[0]).toHaveProperty('truncated');
    expect(result.results[1]).toHaveProperty('error.code', 'HEADING_NOT_FOUND');
  });

  it('a CRLF note returns its heading block with interior CRLF kept and no dangling \\r', async () => {
    const crlf = '# T\r\n## Sub\r\nx\r\ny\r\n## Next\r\nz\r\n';

    const result = await read([{ path: 'c.md', heading: 'Sub' }], { 'c.md': crlf });

    expect(result.results).toStrictEqual([
      {
        path: 'c.md',
        frontmatter: null,
        content: '## Sub\r\nx\r\ny',
        lines: [2, 4],
        heading: 'Sub',
        level: 2,
      },
    ]);
  });
});

describe('operations.readNotes content modes over a selection', () => {
  /**
   * Lines: 1-3 frontmatter, 4 `intro one`, 5 `intro two`, 6 blank, 7 `# Log`, 8 `## 2026-01`,
   * 9 `### 2026-01-15 standup`, 10 `x`, 11 `### 2026-01-20 review`, 12 `y`, 13 `## 2026-02`,
   * 14 `### 2026-02-03 standup`, 15 `z`.
   */
  const LOG = [
    '---',
    'a: 1',
    '---',
    'intro one',
    'intro two',
    '',
    '# Log',
    '## 2026-01',
    '### 2026-01-15 standup',
    'x',
    '### 2026-01-20 review',
    'y',
    '## 2026-02',
    '### 2026-02-03 standup',
    'z',
  ].join('\n');
  const LOG_OUTLINE = [
    { heading: 'Log', level: 1, lines: [7, 15] },
    { heading: '2026-01', level: 2, lines: [8, 12] },
    { heading: '2026-01-15 standup', level: 3, lines: [9, 10] },
    { heading: '2026-01-20 review', level: 3, lines: [11, 12] },
    { heading: '2026-02', level: 2, lines: [13, 15] },
    { heading: '2026-02-03 standup', level: 3, lines: [14, 15] },
  ];

  /** `groups` blocks named `G{g}` one level below `prefix`, each holding `perGroup` `G{g}C{c}`. */
  const grouped = (groups: number, perGroup: number, prefix = '#'): string[] => {
    const lines: string[] = [];
    for (let g = 0; g < groups; g++) {
      lines.push(`${prefix}# G${g}`);
      for (let c = 0; c < perGroup; c++) lines.push(`${prefix}## G${g}C${c}`);
    }
    return lines;
  };

  const read = (
    paths: unknown,
    content?: string,
    files: Record<string, string> = { 'log.md': LOG + '\n' },
  ) =>
    callTool<ReadNotesOut>(
      buildReg(readerOverFiles(files)),
      content === undefined ? { paths } : { paths, content },
    );

  describe("content: 'outline'", () => {
    it('drills into a heading: its echo, then it and its descendants only, with true spans', async () => {
      const result = await read([{ path: 'log.md', heading: '2026-01' }], 'outline');

      expect(result.results).toStrictEqual([
        {
          path: 'log.md',
          frontmatter: { a: 1 },
          lines: [8, 12],
          heading: '2026-01',
          level: 2,
          outline: LOG_OUTLINE.slice(1, 4),
        },
      ]);
    });

    it('lists the heading blocks a lines selection holds, never clipping their spans', async () => {
      // Lines: 1 `# Top`, 2-19 filler, 20 `## B`, 21-45 filler, 46 `## C`, 47 filler.
      const lines = ['# Top', ...Array.from({ length: 18 }, (_, i) => `t${i + 2}`), '## B'];
      lines.push(...Array.from({ length: 25 }, (_, i) => `b${i + 21}`), '## C', 'c47');

      const result = await read([{ path: 'n.md', lines: [12, 30] }], 'outline', {
        'n.md': lines.join('\n') + '\n',
      });

      expect(result.results).toStrictEqual([
        {
          path: 'n.md',
          frontmatter: null,
          lines: [12, 30],
          outline: [{ heading: 'B', level: 2, lines: [20, 45] }],
        },
      ]);
    });

    it('collapses a 133-entry heading selection by its own depth, keeping its shallowest level', async () => {
      // `# Root` holds `## Other` and `## Sel`; `## Sel` holds 12 `###`, each holding 10 `####`.
      const note = ['# Root', '## Other', 'o', '## Sel', ...grouped(12, 10, '##')].join('\n');

      const result = await read([{ path: 'big.md', heading: 'Sel' }], 'outline', {
        'big.md': note + '\n',
      });

      const item = result.results[0] as { outline: unknown[] };
      expect(result.results[0]).toMatchObject({
        lines: [4, 136],
        heading: 'Sel',
        level: 2,
        collapsed: true,
      });
      expect(item.outline).toStrictEqual([
        { heading: 'Sel', level: 2, lines: [4, 136] },
        ...Array.from({ length: 12 }, (_, g) => ({
          heading: `G${g}`,
          level: 3,
          lines: [5 + g * 11, 15 + g * 11],
          hidden: 10,
        })),
      ]);
    });

    it('lists the headings a collapsed note outline hides when drilling into their parent', async () => {
      const note = ['# Title', ...grouped(12, 10)].join('\n') + '\n';

      const result = await read([{ path: 'big.md', heading: 'G3' }], 'outline', {
        'big.md': note,
      });

      expect(result.results).toStrictEqual([
        {
          path: 'big.md',
          frontmatter: null,
          lines: [35, 45],
          heading: 'G3',
          level: 2,
          outline: [
            { heading: 'G3', level: 2, lines: [35, 45] },
            ...Array.from({ length: 10 }, (_, c) => ({
              heading: `G3C${c}`,
              level: 3,
              lines: [36 + c, 36 + c],
            })),
          ],
        },
      ]);
    });

    it('collapses a lines selection with roots at mixed levels by depth, not by level', async () => {
      // Lines: 1 `# Title`, then `## G{g}` at 2 + 11g, each holding ten one-line `### G{g}C{c}`.
      // Lines 4-133 start inside G0: its `###` G0C1..G0C9 and the `##` G1..G11 are all roots.
      const note = ['# Title', ...grouped(12, 10)].join('\n') + '\n';

      const result = await read([{ path: 'big.md', lines: [4, 133] }], 'outline', {
        'big.md': note,
      });

      expect(result.results).toStrictEqual([
        {
          path: 'big.md',
          frontmatter: null,
          lines: [4, 133],
          outline: [
            ...Array.from({ length: 9 }, (_, i) => ({
              heading: `G0C${i + 1}`,
              level: 3,
              lines: [4 + i, 4 + i],
            })),
            ...Array.from({ length: 11 }, (_, i) => ({
              heading: `G${i + 1}`,
              level: 2,
              lines: [13 + i * 11, 23 + i * 11],
              hidden: 10,
            })),
          ],
          collapsed: true,
        },
      ]);
    });

    it('a lines selection over the preamble carries the preamble clipped to it', async () => {
      const result = await read([{ path: 'log.md', lines: [5, 9] }], 'outline');

      expect(result.results).toStrictEqual([
        {
          path: 'log.md',
          frontmatter: { a: 1 },
          lines: [5, 9],
          preamble: [5, 6],
          outline: LOG_OUTLINE.slice(0, 3),
        },
      ]);
    });

    it('carries no preamble when the part of it the selection holds is blank', async () => {
      const result = await read([{ path: 'log.md', lines: [6, 7] }], 'outline');

      expect(result.results).toStrictEqual([
        { path: 'log.md', frontmatter: { a: 1 }, lines: [6, 7], outline: LOG_OUTLINE.slice(0, 1) },
      ]);
    });

    it('a heading selection never carries a preamble', async () => {
      const result = await read([{ path: 'log.md', heading: 'Log' }], 'outline');

      expect(result.results).toStrictEqual([
        {
          path: 'log.md',
          frontmatter: { a: 1 },
          lines: [7, 15],
          heading: 'Log',
          level: 1,
          outline: LOG_OUTLINE,
        },
      ]);
    });
  });

  describe("content: 'frontmatter'", () => {
    it('a resolved selection returns { path, frontmatter } only', async () => {
      const result = await read(
        [
          { path: 'log.md', lines: [5, 6] },
          { path: 'log.md', heading: '2026-02' },
        ],
        'frontmatter',
      );

      expect(result.results).toStrictEqual([
        { path: 'log.md', frontmatter: { a: 1 } },
        { path: 'log.md', frontmatter: { a: 1 } },
      ]);
      expect(result.errors).toBe(0);
    });

    it('still resolves its selector: an unknown heading is a HEADING_NOT_FOUND miss', async () => {
      const result = await read([{ path: 'log.md', heading: 'Missing' }], 'frontmatter');

      expect(result.results).toStrictEqual([
        {
          path: 'log.md',
          error: {
            code: 'HEADING_NOT_FOUND',
            message:
              'no heading block of log.md is named "Missing", exactly or ignoring case and markup; retry with a heading name from outline',
          },
          lines: [4, 15],
          outline: LOG_OUTLINE,
        },
      ]);
      expect(result.errors).toBe(1);
    });

    it('asks the reader for the raw text a selector item needs, and a bare item for no more', async () => {
      const reader = readerOverFiles({ 'log.md': LOG });
      const spy = vi.spyOn(reader, 'readNotes');
      const reg = buildReg(reader);

      await callTool(reg, { paths: [{ path: 'log.md', lines: [5, 6] }], content: 'frontmatter' });
      await callTool(reg, { paths: ['log.md'], content: 'frontmatter' });

      expect(spy.mock.calls.map((c) => c[0].fields)).toStrictEqual([
        ['frontmatter', 'raw'],
        ['frontmatter'],
      ]);
    });
  });

  it.each(['outline', 'frontmatter'])(
    "a miss has the shape it has under content: 'full' under content: '%s'",
    async (content) => {
      const files = { 'log.md': LOG + '\n', 'x.md': '# A\n### Notes\na\n# B\n### Notes\nb\n' };
      const paths = [
        { path: 'log.md', heading: 'Missing' },
        { path: 'x.md', heading: 'Notes' },
        { path: 'log.md', lines: [1, 2] },
      ];

      const asFull = await read(paths, 'full', files);
      const result = await read(paths, content, files);

      expect(result).toStrictEqual(asFull);
      expect(result.errors).toBe(3);
      expect(result.results.map((r) => ('error' in r ? r.error.code : null))).toStrictEqual([
        'HEADING_NOT_FOUND',
        'AMBIGUOUS_MATCH',
        'LINES_OUT_OF_RANGE',
      ]);
      expect(result.results.some((r) => 'frontmatter' in r)).toBe(false);
    },
  );

  it("content: 'full' over a selection returns its text and echo, and no outline fields", async () => {
    const result = await read([{ path: 'log.md', heading: '2026-02' }], 'full');

    expect(result.results).toStrictEqual([
      {
        path: 'log.md',
        frontmatter: { a: 1 },
        content: '## 2026-02\n### 2026-02-03 standup\nz',
        lines: [13, 15],
        heading: '2026-02',
        level: 2,
      },
    ]);
  });
});
