import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_KEY, resolveModelProfile } from '../src/lib/model-profiles.js';
import { startNeuroVaultServer } from '../src/server.js';

/**
 * The server as a client meets it: `startNeuroVaultServer` with its own
 * `McpServer`, reached by an SDK `Client` over an in-memory transport. A
 * malformed call must come back as the gate's `INVALID_PARAMS` envelope, not
 * as the SDK's own `-32602` "Input validation error" text — which is what a
 * client got while the SDK validated `spec.inputSchema` before the gate ran.
 */
describe('tool argument validation over the MCP wire', () => {
  let vault: string;
  let client: Client;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'neuro-vault-wire-'));
    await fs.writeFile(path.join(vault, 'a.md'), '# A\n\nalpha\n', 'utf8');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    dispose = await startNeuroVaultServer(
      {
        vaults: [{ name: 'vault', path: vault }],
        semantic: { enabled: false, model: resolveModelProfile(DEFAULT_MODEL_KEY), shared: false },
      },
      { transportFactory: () => serverTransport as never, stdin: new PassThrough() },
    );
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await dispose();
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('answers a bad read_notes item with the gate envelope naming the bad key', async () => {
    const result = await client.callTool({
      name: 'read_notes',
      arguments: { paths: [{ path: 'a.md', content: 'full' }] },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: 'INVALID_PARAMS',
      message: 'paths.0: Unrecognized key: "content"',
      details: { issues: [{ path: 'paths.0', message: 'Unrecognized key: "content"' }] },
    });
  });

  it('answers a set_property value outside its union with the gate envelope', async () => {
    const result = await client.callTool({
      name: 'set_property',
      arguments: { path: 'a.md', key: 'x', value: { a: 1 } },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'INVALID_PARAMS',
      details: { issues: [{ path: 'value' }] },
    });
  });

  it('still coerces a stringified argument before validating it', async () => {
    const result = await client.callTool({
      name: 'read_notes',
      arguments: { paths: '["a.md"]' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it('answers an unknown tool as the SDK did', async () => {
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'MCP error -32602: Tool no_such_tool not found' },
    ]);
  });

  it('still advertises the full input schema', async () => {
    const { tools } = await client.listTools();
    const readNotes = tools.find((tool) => tool.name === 'read_notes');

    expect(readNotes?.inputSchema).toMatchObject({
      type: 'object',
      required: ['paths'],
      additionalProperties: false,
    });
    expect(Object.keys(readNotes?.inputSchema.properties ?? {})).toContain('content');
  });
});
