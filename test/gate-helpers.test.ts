import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { registerTool } from '../src/lib/tool-registry.js';
import { ToolHandlerError } from '../src/lib/tool-response.js';
import { callTool, expectToolError } from './_gate.js';

function regReturning<T>(value: T) {
  return registerTool({
    name: 'probe',
    description: 'probe',
    inputSchema: z.object({ q: z.string() }),
    handler: async () => value,
  });
}

describe('callTool', () => {
  it('unwraps structuredContent on success', async () => {
    const out = await callTool<{ ok: boolean }>(regReturning({ ok: true }), { q: 'x' });
    expect(out).toEqual({ ok: true });
  });

  it('re-throws a gate rejection as a ToolHandlerError carrying code and issues', async () => {
    const reg = regReturning({ ok: true });
    await expect(callTool(reg, { q: 1 })).rejects.toBeInstanceOf(ToolHandlerError);
    await expect(callTool(reg, { q: 1 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'q' }] },
    });
  });

  it('re-throws a handler error preserving its code and details', async () => {
    const reg = registerTool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({ q: z.string() }),
      handler: async () => {
        throw new ToolHandlerError('NOT_FOUND', 'nope', { details: { path: 'a.md' } });
      },
    });
    await expect(callTool(reg, { q: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'nope',
      details: { path: 'a.md' },
    });
  });

  it('falls back to the text channel for a non-record payload', async () => {
    const out = await callTool<Array<{ a: number }>>(regReturning([{ a: 1 }]), { q: 'x' });
    expect(out).toEqual([{ a: 1 }]);
  });

  it('returns undefined for the ok void sentinel', async () => {
    const reg = registerTool({
      name: 'probe',
      description: 'probe',
      inputSchema: z.object({ q: z.string() }),
      handler: async () => undefined,
    });
    expect(await callTool(reg, { q: 'x' })).toBeUndefined();
  });
});

describe('expectToolError', () => {
  it('returns the structured error payload', async () => {
    const payload = await expectToolError(regReturning({ ok: true }), { q: 1 });
    expect(payload.code).toBe('INVALID_PARAMS');
    expect(payload.message).toContain('q');
  });
});
