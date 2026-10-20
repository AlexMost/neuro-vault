import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { registerResource } from '../../src/lib/resource-registry.js';
import { ToolHandlerError } from '../../src/lib/tool-response.js';
import { readErrorOverWire } from '../_resource-wire.js';

describe('registerResource', () => {
  it('returns a registration with name, uri, metadata, and handler', async () => {
    const reg = registerResource({
      name: 'demo',
      uri: 'demo://thing',
      title: 'Demo Thing',
      description: 'A demo resource.',
      mimeType: 'application/json',
      handler: async () => ({ payload: 42 }),
    });

    expect(reg.name).toBe('demo');
    expect(reg.uri).toBe('demo://thing');
    expect(reg.metadata.title).toBe('Demo Thing');
    expect(reg.metadata.description).toBe('A demo resource.');
    expect(reg.metadata.mimeType).toBe('application/json');

    const result = await reg.handler(new URL('demo://thing'), {} as never);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toEqual({
      uri: 'demo://thing',
      mimeType: 'application/json',
      text: JSON.stringify({ payload: 42 }),
    });
  });

  it('defaults mimeType to application/json when omitted', async () => {
    const reg = registerResource({
      name: 'demo',
      uri: 'demo://thing',
      description: 'A demo resource.',
      handler: async () => ({ ok: true }),
    });

    expect(reg.metadata.mimeType).toBe('application/json');
    const result = await reg.handler(new URL('demo://thing'), {} as never);
    expect(result.contents[0]).toMatchObject({ mimeType: 'application/json' });
  });

  it('omits title from metadata when not provided', async () => {
    const reg = registerResource({
      name: 'demo',
      uri: 'demo://thing',
      description: 'A demo resource.',
      handler: async () => ({}),
    });

    expect('title' in reg.metadata).toBe(false);
  });

  it('passes string payloads through unchanged (no double JSON encoding)', async () => {
    const reg = registerResource({
      name: 'demo',
      uri: 'demo://thing',
      description: 'A demo resource.',
      mimeType: 'text/plain',
      handler: async () => 'hello world',
    });

    const result = await reg.handler(new URL('demo://thing'), {} as never);
    expect(result.contents[0]).toMatchObject({
      uri: 'demo://thing',
      mimeType: 'text/plain',
      text: 'hello world',
    });
  });
});

describe('registerResource: errors on the wire', () => {
  function failingResource(error: Error) {
    return {
      name: 'demo',
      uri: 'demo://thing',
      description: 'A demo resource.',
      handler: async (): Promise<never> => {
        throw error;
      },
    };
  }

  it('a ToolHandlerError with details reaches the client as data, without its cause', async () => {
    const error = await readErrorOverWire(
      failingResource(
        new ToolHandlerError('DEPENDENCY_ERROR', 'Graph read failed', {
          details: { vault: 'work', operation: 'demo://thing' },
          cause: new Error('daemon did not answer in time'),
        }),
      ),
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: -32603,
      message: 'MCP error -32603: Graph read failed',
      data: { code: 'DEPENDENCY_ERROR', details: { vault: 'work', operation: 'demo://thing' } },
    });
    expect((error as McpError).data).toEqual({
      code: 'DEPENDENCY_ERROR',
      details: { vault: 'work', operation: 'demo://thing' },
    });
    expect(JSON.stringify(error)).not.toContain('daemon did not answer');
    expect((error as McpError).message).not.toContain('daemon did not answer');
  });

  it('a ToolHandlerError without details has no details key', async () => {
    const error = await readErrorOverWire(
      failingResource(new ToolHandlerError('NOT_FOUND', 'Note not found')),
    );

    expect(error).toMatchObject({ code: -32603, message: 'MCP error -32603: Note not found' });
    const data = (error as McpError).data as Record<string, unknown>;
    expect(data).toEqual({ code: 'NOT_FOUND' });
    expect('details' in data).toBe(false);
  });

  it('a plain Error reaches the client with its message and no data', async () => {
    const error = await readErrorOverWire(failingResource(new Error('disk read failed')));

    expect(error).toMatchObject({ code: -32603, message: 'MCP error -32603: disk read failed' });
    expect((error as McpError).data).toBeUndefined();
  });
});
