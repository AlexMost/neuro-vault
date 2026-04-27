import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ITool } from '../../src/lib/tool-registry.js';
import { registerTool } from '../../src/lib/tool-registry.js';

describe('registerTool', () => {
  it('produces a ToolRegistration carrying name, description, and inputSchema', () => {
    const schema = z.object({ x: z.number() });
    const tool: ITool<{ x: number }, { y: number }> = {
      name: 'noop',
      title: 'Noop',
      description: 'does nothing',
      inputSchema: schema,
      handler: async (input) => ({ y: input.x + 1 }),
    };

    const reg = registerTool(tool);
    expect(reg.name).toBe('noop');
    expect(reg.spec.title).toBe('Noop');
    expect(reg.spec.description).toBe('does nothing');
    expect(reg.spec.inputSchema).toBe(schema);
  });

  it('parses input through the schema before invoking the handler', async () => {
    const schema = z.object({ x: z.number() });
    let received: unknown = null;
    const tool: ITool<{ x: number }, { y: number }> = {
      name: 'echo',
      description: 'echo',
      inputSchema: schema,
      handler: async (input) => {
        received = input;
        return { y: input.x };
      },
    };

    const reg = registerTool(tool);
    const result = await reg.handler({ x: 7, extra: 'ignored' });

    expect(received).toEqual({ x: 7 });
    expect(result.structuredContent).toEqual({ y: 7 });
  });

  it('translates a thrown ToolHandlerError into the structured error response', async () => {
    const { ToolHandlerError } = await import('../../src/lib/tool-response.js');
    const tool: ITool<{ x: number }, never> = {
      name: 'boom',
      description: 'boom',
      inputSchema: z.object({ x: z.number() }),
      handler: async () => {
        throw new ToolHandlerError('INVALID_ARGUMENT', 'nope', { details: { field: 'x' } });
      },
    };

    const reg = registerTool(tool);
    const result = await reg.handler({ x: 1 });

    expect(result.isError).toBe(true);
    const errPayload = result.structuredContent as { code: string; message: string };
    expect(errPayload.code).toBe('INVALID_ARGUMENT');
    expect(errPayload.message).toBe('nope');
  });
});
