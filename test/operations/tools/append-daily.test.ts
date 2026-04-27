import { describe, expect, it } from 'vitest';

import { buildAppendDailyTool } from '../../../src/modules/operations/tools/append-daily.js';
import { makeProvider } from './_helpers.js';

describe('operations.appendDaily handler', () => {
  it('forwards content', async () => {
    const provider = makeProvider();
    const tool = buildAppendDailyTool({ provider });

    await tool.handler({ content: '- task' });

    expect(provider.appendDaily).toHaveBeenCalledWith({ content: '- task' });
  });

  it('rejects empty content', async () => {
    const tool = buildAppendDailyTool({ provider: makeProvider() });
    await expect(tool.handler({ content: '   ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
