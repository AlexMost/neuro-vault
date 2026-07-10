import { describe, expect, it } from 'vitest';
import { invokeTool, toToolResponse } from '../../src/lib/tool-response.js';

describe('toToolResponse', () => {
  it('returns a non-empty text block when handler returns undefined', () => {
    const result = toToolResponse(undefined);
    expect(result.content).toHaveLength(1);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.type).toBe('text');
    expect(typeof block.text).toBe('string');
    expect(block.text.length).toBeGreaterThan(0);
  });

  it('serializes objects as minified JSON equal to structuredContent', () => {
    const result = toToolResponse({ path: 'a.md', nested: { n: 1 } });
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('{"path":"a.md","nested":{"n":1}}');
    expect(block.text).toBe(JSON.stringify(result.structuredContent));
  });

  it('serializes arrays as minified JSON without structuredContent', () => {
    const result = toToolResponse([{ name: 'a' }]);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('[{"name":"a"}]');
    expect(result.structuredContent).toBeUndefined();
  });

  it('keeps the ok sentinel for void results', () => {
    const result = toToolResponse(undefined);
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('ok');
    expect(result.structuredContent).toBeUndefined();
  });
});

describe('invokeTool', () => {
  it('produces a valid text block when the handler resolves to void', async () => {
    const result = await invokeTool(async () => {
      // simulate editNote / appendDaily — returns Promise<void>
    });
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.type).toBe('text');
    expect(typeof block.text).toBe('string');
    expect(block.text.length).toBeGreaterThan(0);
  });
});
