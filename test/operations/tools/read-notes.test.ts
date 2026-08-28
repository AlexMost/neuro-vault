import { describe, expect, it } from 'vitest';

import { buildReadNotesTool } from '../../../src/modules/operations/tools/read-notes.js';
import { PREVIEW_CHAR_CAP, PREVIEW_MARKER } from '../../../src/modules/operations/preview-body.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { callTool } from '../../_gate.js';
import type { ReadNotesResult } from '../../../src/modules/operations/types.js';
import type { VaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import { makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

type ReadNotesOut = { vault: string } & ReadNotesResult;

function buildReg(reader: VaultReader = makeReader()) {
  return registerTool(buildReadNotesTool({ registry: makeTestRegistry([{ name: 'v', reader }]) }));
}

describe('operations.readNotes handler', () => {
  it('reads a single path with no content (default full) and includes vault', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['Folder/n.md'] });

    expect(result).toEqual({
      vault: 'v',
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
      count: 1,
      errors: 0,
    });
    expect((result.results[0] as { truncated?: boolean }).truncated).toBeUndefined();
  });

  it('accepts a single string for paths and returns identical shape to the array form', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: 'Folder/n.md' });

    expect(result).toEqual({
      vault: 'v',
      results: [{ path: 'Folder/n.md', frontmatter: { a: 1 }, content: 'body' }],
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

  it('single path + no content defaults to full { path, frontmatter, content } (no truncated)', async () => {
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'full body here' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['a.md'] });

    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'full body here',
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
    const reader = makeReader({
      readNotes: async () => [{ path: 'a.md', frontmatter: { x: 1 }, content: 'full body' }],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), { paths: ['a.md', 'a.md'] });

    expect(result.count).toBe(1);
    expect(result.results[0]).toEqual({
      path: 'a.md',
      frontmatter: { x: 1 },
      content: 'full body',
    });
  });

  it("content: 'full' on a multi-path call returns all full (override)", async () => {
    const reader = makeReader({
      readNotes: async () => [
        { path: 'a.md', frontmatter: { x: 1 }, content: 'body a' },
        { path: 'b.md', frontmatter: { y: 2 }, content: 'body b' },
      ],
    });

    const result = await callTool<ReadNotesOut>(buildReg(reader), {
      paths: ['a.md', 'b.md'],
      content: 'full',
    });

    expect(result.results[0]).toEqual({ path: 'a.md', frontmatter: { x: 1 }, content: 'body a' });
    expect(result.results[1]).toEqual({ path: 'b.md', frontmatter: { y: 2 }, content: 'body b' });
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

  it('rejects an invalid content value at the gate', async () => {
    await expect(callTool(buildReg(), { paths: ['a.md'], content: 'none' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'content' }] },
    });
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
      details: { issues: [{ path: '<root>', message: 'Unrecognized key: "fields"' }] },
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
      details: { issues: [{ path: '<root>', message: 'Unrecognized key: "vault"' }] },
    });
  });
});
