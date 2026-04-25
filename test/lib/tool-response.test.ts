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

  it('serializes objects as pretty JSON', () => {
    const result = toToolResponse({ path: 'a.md' });
    const block = result.content[0] as { type: 'text'; text: string };
    expect(block.text).toBe('{\n  "path": "a.md"\n}');
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
