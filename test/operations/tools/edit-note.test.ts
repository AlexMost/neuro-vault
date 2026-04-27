import { describe, expect, it } from 'vitest';

import { buildEditNoteTool } from '../../../src/modules/operations/tools/edit-note.js';
import { makeProvider } from './_helpers.js';

describe('operations.editNote handler', () => {
  it('forwards identifier, content, and position', async () => {
    const provider = makeProvider();
    const tool = buildEditNoteTool({ provider });

    await tool.handler({
      path: 'Notes/x.md',
      content: 'tail',
      position: 'append',
    });

    expect(provider.editNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      content: 'tail',
      position: 'append',
    });
  });

  it('rejects invalid path', async () => {
    const tool = buildEditNoteTool({ provider: makeProvider() });
    await expect(
      tool.handler({ path: '../bad', content: 'x', position: 'append' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Unix absolute path', async () => {
    const provider = makeProvider();
    const tool = buildEditNoteTool({ provider });
    await expect(
      tool.handler({ path: '/etc/passwd', content: 'x', position: 'append' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.editNote).not.toHaveBeenCalled();
  });
});
