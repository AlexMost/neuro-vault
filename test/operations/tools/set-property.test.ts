import { describe, expect, it } from 'vitest';

import { buildSetPropertyTool } from '../../../src/modules/operations/tools/set-property.js';
import { makeProvider } from './_helpers.js';

describe('operations.setProperty handler', () => {
  it('infers type=text for string value', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({ path: 'a.md', key: 'status', value: 'done' });

    expect(provider.setProperty).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'a.md' },
      name: 'status',
      value: 'done',
      type: 'text',
    });
  });

  it('infers type=number for number value', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({ path: 'a.md', key: 'priority', value: 3 });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: 3, type: 'number' }),
    );
  });

  it('infers type=checkbox for boolean value', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({ path: 'a.md', key: 'done', value: true });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: true, type: 'checkbox' }),
    );
  });

  it('infers type=list for array value', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({ path: 'a.md', key: 'tags', value: ['mcp', 'todo'] });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: ['mcp', 'todo'], type: 'list' }),
    );
  });

  it('explicit type overrides inference', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({ path: 'a.md', key: 'due', value: '2026-05-01', type: 'date' });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01', type: 'date' }),
    );
  });

  it('rejects non-ISO date format with INVALID_ARGUMENT', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({ path: 'a.md', key: 'due', value: '03.05.2026', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects logically invalid date with INVALID_ARGUMENT', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({ path: 'a.md', key: 'due', value: '2026-13-45', type: 'date' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects non-string value when type=date', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({
        path: 'a.md',
        key: 'due',
        value: 12345 as unknown as string,
        type: 'date',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('accepts ISO datetime with explicit type=datetime', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await tool.handler({
      path: 'a.md',
      key: 'startedAt',
      value: '2026-05-01T14:30:00Z',
      type: 'datetime',
    });

    expect(provider.setProperty).toHaveBeenCalledWith(
      expect.objectContaining({ value: '2026-05-01T14:30:00Z', type: 'datetime' }),
    );
  });

  it('rejects space-separated datetime as non-ISO', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({
        path: 'a.md',
        key: 'startedAt',
        value: '2026-05-01 14:30:00',
        type: 'datetime',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects array element containing comma', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({ path: 'a.md', key: 'tags', value: ['hello, world', 'ok'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects null/undefined value with UNSUPPORTED_VALUE_TYPE', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });

    await expect(
      tool.handler({ path: 'a.md', key: 'x', value: null as unknown as string }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_VALUE_TYPE' });
  });

  it('rejects when neither name nor path is provided', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });
    await expect(tool.handler({ key: 'x', value: 'y' } as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when both name and path are provided', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });
    await expect(
      tool.handler({ name: 'a', path: 'b.md', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects path traversal', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });
    await expect(
      tool.handler({ path: '../../etc/passwd', key: 'x', value: 'y' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });

  it('rejects absolute path', async () => {
    const provider = makeProvider();
    const tool = buildSetPropertyTool({ provider });
    await expect(tool.handler({ path: '/tmp/x.md', key: 'x', value: 'y' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.setProperty).not.toHaveBeenCalled();
  });
});
