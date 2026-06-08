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
    // spec.inputSchema is a coercion-wrapped variant of the original — the SDK
    // validates against this so stringified primitives are accepted.
    expect(reg.spec.inputSchema).toBeDefined();
    expect(reg.spec.inputSchema).not.toBe(schema);
  });

  it('exposes a spec.inputSchema that itself coerces (the path the MCP SDK takes)', () => {
    const schema = z.object({
      limit: z.number().int().positive().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      flag: z.boolean().optional(),
    });
    const tool: ITool<z.infer<typeof schema>, { ok: true }> = {
      name: 'sdk-path',
      description: 'sdk-path',
      inputSchema: schema,
      handler: async () => ({ ok: true }),
    };

    const reg = registerTool(tool);
    const result = (reg.spec.inputSchema as z.ZodTypeAny).safeParse({
      limit: '5',
      filter: '{"tags":"x"}',
      flag: 'false',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ limit: 5, filter: { tags: 'x' }, flag: false });
    }
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
    const result = await reg.handler({ x: 7 });

    expect(received).toEqual({ x: 7 });
    expect(result.structuredContent).toEqual({ y: 7 });
  });

  it('omits structuredContent when the handler returns an array (MCP rejects array structuredContent)', async () => {
    const schema = z.object({});
    const tool: ITool<unknown, Array<{ name: string }>> = {
      name: 'list',
      description: 'list',
      inputSchema: schema,
      handler: async () => [{ name: 'a' }, { name: 'b' }],
    };

    const reg = registerTool(tool);
    const result = await reg.handler({});

    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: JSON.stringify([{ name: 'a' }, { name: 'b' }], null, 2),
    });
  });

  it('coerces stringified primitives before invoking the handler', async () => {
    const schema = z.object({
      limit: z.number().int().positive().optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      flag: z.boolean().optional(),
    });
    let received: unknown = null;
    const tool: ITool<z.infer<typeof schema>, { ok: true }> = {
      name: 'coerce',
      description: 'coerce',
      inputSchema: schema,
      handler: async (input) => {
        received = input;
        return { ok: true };
      },
    };

    const reg = registerTool(tool);
    const result = await reg.handler({
      limit: '5',
      filter: '{"tags":"x"}',
      flag: 'true',
    });

    expect(result.isError).not.toBe(true);
    expect(received).toEqual({ limit: 5, filter: { tags: 'x' }, flag: true });
  });

  it('returns INVALID_PARAMS with a structured issues list when validation fails', async () => {
    const schema = z.object({ limit: z.number().int().positive() });
    const tool: ITool<{ limit: number }, { ok: true }> = {
      name: 'bad-input',
      description: 'bad-input',
      inputSchema: schema,
      handler: async () => ({ ok: true }),
    };

    const reg = registerTool(tool);
    const result = await reg.handler({ limit: 'abc' });

    expect(result.isError).toBe(true);
    const errPayload = result.structuredContent as {
      code: string;
      message: string;
      details: { issues: Array<{ path: string; message: string; expected?: string }> };
    };
    expect(errPayload.code).toBe('INVALID_PARAMS');
    expect(errPayload.message).toContain('limit');
    expect(errPayload.details.issues[0]?.path).toBe('limit');
  });

  it('surfaces a meaningful coerce-failure message in INVALID_PARAMS without duplicating the field name', async () => {
    const schema = z.object({
      filter: z.record(z.string(), z.unknown()),
      include_content: z.boolean().optional(),
    });
    const tool: ITool<z.infer<typeof schema>, { ok: true }> = {
      name: 'coerce-fail',
      description: 'coerce-fail',
      inputSchema: schema,
      handler: async () => ({ ok: true }),
    };

    const reg = registerTool(tool);
    const result = await reg.handler({ filter: 'not json', include_content: 'maybe' });

    expect(result.isError).toBe(true);
    const errPayload = result.structuredContent as {
      code: string;
      message: string;
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(errPayload.code).toBe('INVALID_PARAMS');
    expect(errPayload.message).toMatch(/filter:\s+expected object or JSON-string of one/);
    expect(errPayload.message).toMatch(/include_content:\s+expected boolean or "true"\/"false"/);
    expect(errPayload.message).not.toMatch(/filter:\s+filter:/);
    expect(errPayload.message).not.toMatch(/include_content:\s+include_content:/);
    const paths = errPayload.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(['filter', 'include_content']);
  });

  it('rejects unknown top-level parameters with INVALID_PARAMS naming the key', async () => {
    const schema = z.object({ content: z.string().optional() });
    const tool: ITool<{ content?: string }, { ok: true }> = {
      name: 'strict-check',
      description: 'strict-check',
      inputSchema: schema,
      handler: async () => ({ ok: true }),
    };

    const reg = registerTool(tool);
    // Darwin's scenario: a frontmatter param that does not exist in the schema.
    const result = await reg.handler({ content: 'body', frontmatter: { type: 'note' } });

    expect(result.isError).toBe(true);
    const errPayload = result.structuredContent as { code: string; message: string };
    expect(errPayload.code).toBe('INVALID_PARAMS');
    expect(errPayload.message).toContain('frontmatter');
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

describe('registerTool — inputAliases', () => {
  const schema = z.object({
    filter: z.record(z.string(), z.unknown()),
  });
  function makeTool(): ITool<{ filter?: Record<string, unknown> }, { received: unknown }> {
    return {
      name: 'aliased',
      description: 'aliased',
      inputSchema: schema,
      inputAliases: { filters: 'filter' },
      handler: async (input) => ({ received: input.filter }),
    };
  }

  it('renames an alias key to its canonical parameter', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ filters: { a: 1 } });
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { received: unknown }).received).toEqual({ a: 1 });
  });

  it('keeps the canonical value when both alias and canonical are present', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ filter: { keep: true }, filters: { drop: true } });
    expect((result.structuredContent as { received: unknown }).received).toEqual({ keep: true });
  });

  it('still rejects a genuinely unknown, non-alias key', async () => {
    const reg = registerTool(makeTool());
    const result = await reg.handler({ totally_unknown: 1 });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe('INVALID_PARAMS');
  });

  it('advertises a ZodObject (not a pipe) so the MCP SDK can read the params', () => {
    // The SDK reads spec.inputSchema both to advertise the JSON schema and as its
    // own pre-validation gate. A ZodPipe (from z.preprocess) advertises as an empty
    // object — so the advertised schema MUST stay a ZodObject exposing the params.
    const reg = registerTool(makeTool());
    expect(reg.spec.inputSchema).toBeInstanceOf(z.ZodObject);
    expect(Object.keys((reg.spec.inputSchema as z.ZodObject).shape)).toContain('filter');
  });

  it('advertised schema tolerates the alias key (SDK pre-validation must not reject it)', () => {
    const reg = registerTool(makeTool());
    // The SDK parses raw args against spec.inputSchema BEFORE our handler; it must
    // not reject `filters` there, or the alias rename never runs.
    // With `filter` required, this is a REAL test: before the fix, SDK gate rejects
    // `{ filters }` because the required canonical `filter` is missing.
    expect((reg.spec.inputSchema as z.ZodObject).safeParse({ filters: { a: 1 } }).success).toBe(
      true,
    );
  });

  it('alias-only call passes the SDK gate and reaches the handler renamed', async () => {
    const reg = registerTool(makeTool());
    // mimic the SDK: pre-validate raw args against spec.inputSchema, then call the handler
    const parsed = (reg.spec.inputSchema as z.ZodType).parse({ filters: { a: 1 } });
    const result = await reg.handler(parsed);
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { received: unknown }).received).toEqual({ a: 1 });
  });

  it('a call with neither alias nor canonical is still rejected by the handler gate', async () => {
    const reg = registerTool(makeTool());
    const parsed = (reg.spec.inputSchema as z.ZodType).parse({}); // SDK gate now allows missing canonical
    const result = await reg.handler(parsed);
    expect(result.isError).toBe(true);
    expect((result.structuredContent as { code: string }).code).toBe('INVALID_PARAMS');
  });

  it('advertises a ZodObject for a tool without aliases (unchanged behavior)', () => {
    const tool: ITool<{ x?: number }, { ok: true }> = {
      name: 'plain',
      description: 'plain',
      inputSchema: z.object({ x: z.number().optional() }),
      handler: async () => ({ ok: true }),
    };
    const reg = registerTool(tool);
    expect(reg.spec.inputSchema).toBeInstanceOf(z.ZodObject);
  });
});
