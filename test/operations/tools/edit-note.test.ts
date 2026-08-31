import { describe, expect, it, vi } from 'vitest';

import { registerTool } from '../../../src/lib/tool-registry.js';
import { buildEditNoteTool } from '../../../src/modules/operations/tools/edit-note.js';
import { FsVaultProvider } from '../../../src/modules/operations/fs-vault-provider.js';
import { callTool } from '../../_gate.js';
import { makeProvider, makeReader } from './_helpers.js';
import { makeTestRegistry } from './_test-registry.js';

function buildTool(
  overrides: {
    reader?: ReturnType<typeof makeReader>;
    provider?: ReturnType<typeof makeProvider>;
  } = {},
) {
  const reader = overrides.reader ?? makeReader();
  const provider = overrides.provider ?? makeProvider();
  const registry = makeTestRegistry([{ name: 'v', reader, provider }]);
  const tool = buildEditNoteTool({ registry });
  return { tool, reader, provider };
}

describe('edit_note: targeted replace (replace field present)', () => {
  it('routes to provider.replaceInNote with a path identifier and returns { vault }', async () => {
    const { tool, provider } = buildTool();
    const result = await callTool(registerTool(tool), {
      path: 'Notes/x.md',
      content: 'new',
      replace: 'old',
    });
    expect(provider.replaceInNote).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      find: 'old',
      content: 'new',
    });
    expect(provider.replaceFullBody).not.toHaveBeenCalled();
    expect(result).toEqual({ vault: 'v' });
  });

  // The tool now validates its arguments before any disk I/O, so a malformed
  // `replace` is reported even when the identifier would not have resolved.
  // Previously `edit_note` resolved name -> path first and reported NOT_FOUND.
  it('rejects empty replace before resolving an unresolvable name', async () => {
    const reader = makeReader({ scan: vi.fn().mockResolvedValue([]) });
    const { tool, provider } = buildTool({ reader });

    await expect(
      callTool(registerTool(tool), { name: 'Nope', content: 'y', replace: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'replace' } });
    expect(provider.replaceInNote).not.toHaveBeenCalled();
  });

  it('rejects invalid path', async () => {
    const { tool } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: '../bad', content: 'y', replace: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('rejects Unix absolute path', async () => {
    const { tool, provider } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: '/etc/passwd', content: 'y', replace: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.replaceInNote).not.toHaveBeenCalled();
  });

  it('passes a name identifier down unresolved', async () => {
    const { tool, provider } = buildTool();
    await callTool(registerTool(tool), { name: '  Foo  ', content: 'body' });

    expect(provider.replaceFullBody).toHaveBeenCalledWith({
      identifier: { kind: 'name', value: 'Foo' },
      content: 'body',
    });
  });
});

describe('edit_note: full-body replace (replace field absent)', () => {
  it('routes to provider.replaceFullBody and returns { vault }', async () => {
    const { tool, provider } = buildTool();
    const result = await callTool(registerTool(tool), {
      path: 'Notes/x.md',
      content: 'whole new body',
    });
    expect(provider.replaceFullBody).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      content: 'whole new body',
    });
    expect(provider.replaceInNote).not.toHaveBeenCalled();
    expect(result).toEqual({ vault: 'v' });
  });

  it('allows empty content', async () => {
    const { tool, provider } = buildTool();
    await callTool(registerTool(tool), { path: 'Notes/x.md', content: '' });
    expect(provider.replaceFullBody).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Notes/x.md' },
      content: '',
    });
  });
});

describe('edit_note: path auto-promotion', () => {
  it('auto-appends .md to a path without an extension', async () => {
    const { tool, provider } = buildTool();
    await callTool(registerTool(tool), { path: 'Foo', content: 'body' });
    expect(provider.replaceFullBody).toHaveBeenCalledWith({
      identifier: { kind: 'path', value: 'Foo.md' },
      content: 'body',
    });
  });
});

describe('edit_note: disk write failures reach the client with a code', () => {
  // ADR-0003: every tool error the client sees carries `{ code, message,
  // details }`. A failing fs write used to escape FsVaultProvider as a bare
  // Error, which `toToolErrorResponse` renders through its code-less branch —
  // nothing for an LLM client to branch on. Exercise the real provider through
  // the registered tool so both the mapping and the rendering are asserted.
  function buildWithFailingDisk() {
    const provider = new FsVaultProvider({
      vaultRoot: '/vault',
      reader: makeReader(),
      readFile: vi.fn().mockResolvedValue('---\nx: y\n---\nold body\n'),
      writeFile: vi.fn().mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        }),
      ),
    });
    const registry = makeTestRegistry([{ name: 'v', reader: makeReader(), provider }]);
    return registerTool(buildEditNoteTool({ registry }));
  }

  // Intentionally handler-direct on the registration: the subject here is the
  // CallToolResult envelope itself (isError + structuredContent), not the
  // unwrapped payload, so `callTool` would hide what is under test.
  it('surfaces WRITE_FAILED on a full-body rewrite', async () => {
    const result = await buildWithFailingDisk().handler({ path: 'n.md', content: 'new' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'WRITE_FAILED',
      details: { path: 'n.md' },
    });
  });

  // Handler-direct for the same reason as the test above.
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
    await expect(
      callTool(registerTool(tool), { name: 'X', path: 'X.md', content: 'y' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects when neither name nor path is provided', async () => {
    const { tool } = buildTool();
    await expect(callTool(registerTool(tool), { content: 'y' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects an unknown key', async () => {
    const { tool } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: 'n.md', content: 'x', append: true }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('append') }] },
    });
  });

  it('rejects a vault argument in single-vault mode', async () => {
    const { tool } = buildTool();
    await expect(
      callTool(registerTool(tool), { path: 'n.md', content: 'x', vault: 'v' }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: '<root>', message: expect.stringContaining('vault') }] },
    });
  });
});
