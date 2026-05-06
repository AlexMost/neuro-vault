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

describe('edit_note: targeted replace (replace field present)', () => {
  it('routes to writer.replaceInNote with normalised path', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
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
  it('routes to writer.replaceFullBody', async () => {
    const { tool, writer } = buildTool();
    await tool.handler({
      path: 'Notes/x.md',
      content: 'whole new body',
    });
    expect(writer.replaceFullBody).toHaveBeenCalledWith({
      path: 'Notes/x.md',
      content: 'whole new body',
    });
    expect(writer.replaceInNote).not.toHaveBeenCalled();
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

describe('edit_note: identifier validation', () => {
  it('rejects when both name and path are provided', async () => {
    const { tool } = buildTool();
    await expect(tool.handler({ name: 'X', path: 'X.md', content: 'y' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when neither name nor path is provided', async () => {
    const { tool } = buildTool();
    await expect(tool.handler({ content: 'y' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
