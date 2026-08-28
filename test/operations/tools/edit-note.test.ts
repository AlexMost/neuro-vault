import { describe, expect, it, vi } from 'vitest';

import { FsVaultWriter } from '../../../src/lib/obsidian/vault-writer.js';
import { registerTool } from '../../../src/lib/tool-registry.js';
import { buildEditNoteTool } from '../../../src/modules/operations/tools/edit-note.js';
import { makeReader, makeWriter } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildTool(
  overrides: {
    reader?: ReturnType<typeof makeReader>;
    writer?: ReturnType<typeof makeWriter>;
  } = {},
) {
  const reader = overrides.reader ?? makeReader();
  const writer = overrides.writer ?? makeWriter();
  const registry = makeTestRegistry([{ name: 'v', reader, writer }]);
  const tool = buildEditNoteTool({ registry });
  return { tool, reader, writer };
}

describe('edit_note: targeted replace (replace field present)', () => {
  it('routes to writer.replaceInNote with normalised path and returns { vault }', async () => {
    const { tool, writer } = buildTool();
    const result = await tool.handler({
      path: 'Notes/x.md',
      content: 'new',
      replace: 'old',
    });
    expect(writer.replaceInNote).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      find: 'old',
      content: 'new',
    });
    expect(writer.replaceFullBody).not.toHaveBeenCalled();
    expect(result).toEqual({ vault: 'v' });
  });

  it('rejects empty replace with INVALID_ARGUMENT', async () => {
    const { tool, writer } = buildTool();
    await expect(tool.handler({ path: 'x.md', content: 'y', replace: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });

  it('rejects invalid path', async () => {
    const { tool } = buildTool();
    await expect(
      tool.handler({ path: '../bad', content: 'y', replace: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Unix absolute path', async () => {
    const { tool, writer } = buildTool();
    await expect(
      tool.handler({ path: '/etc/passwd', content: 'y', replace: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });

  it('resolves name → path via reader.scan (unique match)', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['Folder/My Note.md', 'Folder/Other.md']),
    });
    const { tool, writer } = buildTool({ reader });
    await tool.handler({
      name: 'My Note',
      content: 'new',
      replace: 'old',
    });
    expect(writer.replaceInNote).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Folder/My Note.md' }),
    );
  });

  it('rejects ambiguous name with AMBIGUOUS_MATCH', async () => {
    const reader = makeReader({
      scan: vi.fn().mockResolvedValue(['A/My Note.md', 'B/My Note.md']),
    });
    const { tool, writer } = buildTool({ reader });
    await expect(
      tool.handler({ name: 'My Note', content: 'new', replace: 'old' }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_MATCH',
      details: { matches: ['A/My Note.md', 'B/My Note.md'] },
      // Candidate paths must also be in the human message for clients that
      // only render the text content of the error.
      message: expect.stringContaining('A/My Note.md, B/My Note.md'),
    });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });

  it('rejects unresolved name with NOT_FOUND', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['Other.md']) });
    const { tool, writer } = buildTool({ reader });
    await expect(
      tool.handler({ name: 'Missing', content: 'new', replace: 'old' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });
});

describe('edit_note: full-body replace (replace field absent)', () => {
  it('routes to writer.replaceFullBody and returns { vault }', async () => {
    const { tool, writer } = buildTool();
    const result = await tool.handler({
      path: 'Notes/x.md',
      content: 'whole new body',
    });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      content: 'whole new body',
    });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
    expect(result).toEqual({ vault: 'v' });
  });

  it('allows empty content', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({ path: 'Notes/x.md', content: '' });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      content: '',
    });
  });
});

describe('edit_note: path auto-promotion', () => {
  it('auto-appends .md to a path without an extension', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({ path: 'Foo', content: 'body' });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Foo.md',
      content: 'body',
    });
  });
});

describe('edit_note: disk write failures reach the client with a code', () => {
  // ADR-0003: every tool error the client sees carries `{ code, message,
  // details }`. A failing fs write used to escape FsVaultWriter as a bare
  // Error, which `toToolErrorResponse` renders through its code-less branch —
  // nothing for an LLM client to branch on. Exercise the real writer through
  // the registered tool so both the mapping and the rendering are asserted.
  function buildWithFailingDisk() {
    const writer = new FsVaultWriter({
      vaultRoot: '/vault',
      readFile: vi.fn().mockResolvedValue('---\nx: y\n---\nold body\n'),
      writeFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }),
      ),
    });
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), writer }]);
    return registerTool(buildEditNoteTool({ registry }));
  }

  it('surfaces WRITE_FAILED on a full-body rewrite', async () => {
    const result = await buildWithFailingDisk().handler({ path: 'n.md', content: 'new' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'WRITE_FAILED',
      details: { path: 'n.md' },
    });
  });

  it('surfaces WRITE_FAILED on a targeted replace', async () => {
    const result = await buildWithFailingDisk().handler({
      path: 'n.md',
      content: 'new',
      replace: 'old body',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'WRITE_FAILED',
      details: { path: 'n.md' },
    });
  });
});

describe('edit_note: identifier validation', () => {
  it('rejects when both name and path are provided', async () => {
    const { tool } = buildTool();
    await expect(tool.handler({ name: 'X', path: 'X.md', content: 'y' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when neither name nor path is provided', async () => {
    const { tool } = buildTool();
    await expect(tool.handler({ content: 'y' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
