import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerResource, type IResource } from '../src/lib/resource-registry.js';

/**
 * Read `resource` the way a client does: registered through `registerResource`
 * on a real `McpServer`, read by an SDK `Client` over an in-memory transport.
 * Resolves with the read's rejection — the error the client sees after the SDK
 * serialised it to JSON-RPC and back — or `undefined` if the read succeeded.
 */
export async function readErrorOverWire<O>(resource: IResource<O>): Promise<unknown> {
  const reg = registerResource(resource);
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  server.registerResource(reg.name, reg.uri, reg.metadata, reg.handler);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.readResource({ uri: reg.uri });
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await client.close();
    await server.close();
  }
}
