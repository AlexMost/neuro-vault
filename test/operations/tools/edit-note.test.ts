import { describe, expect, it, vi } from 'vitest';

import { buildEditNoteTool } from '../../../src/modules/operations/tools/edit-note.js';
import { makeReader, makeWriter } from './_helpers.js';

function buildTool(
  overrides: {
    reader?: ReturnType<typeof makeReader>;
    writer?: ReturnType<typeof makeWriter>;
  } = {},
) {
  const reader = overrides.reader ?? makeReader();
  const writer = overrides.writer ?? makeWriter();
  const tool = buildEditNoteTool({ reader, writer });
  return { tool, reader, writer };
}

describe('edit_note: replace', () => {
  it('routes to writer.replaceInNote with normalised path', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
      path: 'Notes/x.md',
      content: 'new',
      position: 'replace',
      find: 'old',
    });
    expect(writer.replaceInNote).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      find: 'old',
      content: 'new',
      replaceAll: false,
    });
  });

  it('passes replace_all through', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
      path: 'Notes/x.md',
      content: 'new',
      position: 'replace',
      find: 'old',
      replace_all: true,
    });
    expect(writer.replaceInNote).toHaveBeenCalledWith(
      expect.objectContaining({ replaceAll: true }),
    );
  });

  it('rejects empty find with INVALID_ARGUMENT', async () => {
    const { tool, writer } = buildTool();
    await expect(
      tool.handler({ path: 'x.md', content: 'y', position: 'replace', find: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });

  it('rejects invalid path', async () => {
    const { tool } = buildTool();
    await expect(
      tool.handler({ path: '../bad', content: 'y', position: 'replace', find: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Unix absolute path', async () => {
    const { tool, writer } = buildTool();
    await expect(
      tool.handler({ path: '/etc/passwd', content: 'y', position: 'replace', find: 'x' }),
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
      position: 'replace',
      find: 'old',
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
      tool.handler({
        name: 'My Note',
        content: 'new',
        position: 'replace',
        find: 'old',
      }),
    ).rejects.toMatchObject({
      code: 'AMBIGUOUS_MATCH',
      details: { matches: ['A/My Note.md', 'B/My Note.md'] },
    });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });

  it('rejects unresolved name with NOT_FOUND', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue(['Other.md']) });
    const { tool, writer } = buildTool({ reader });
    await expect(
      tool.handler({
        name: 'Missing',
        content: 'new',
        position: 'replace',
        find: 'old',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
  });
});

describe('edit_note: replace_full', () => {
  it('routes to writer.replaceFullBody', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
      path: 'Notes/x.md',
      content: 'whole new body',
      position: 'replace_full',
    });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      content: 'whole new body',
    });
  });

  it('allows empty content', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
      path: 'Notes/x.md',
      content: '',
      position: 'replace_full',
    });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      content: '',
    });
  });
});

describe('edit_note: identifier validation', () => {
  it('rejects when both name and path are provided', async () => {
    const { tool } = buildTool();
    await expect(
      tool.handler({
        name: 'X',
        path: 'X.md',
        content: 'y',
        position: 'replace_full',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects when neither name nor path is provided', async () => {
    const { tool } = buildTool();
    await expect(
      tool.handler({ content: 'y', position: 'replace_full' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
