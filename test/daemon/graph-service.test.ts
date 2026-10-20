import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonRpcError,
  ServiceRegistry,
  type VaultAttachResult,
} from '../../src/daemon/protocol.js';
import { createGraphService } from '../../src/daemon/services/graph.js';
import { createVaultEntryServices } from '../../src/daemon/services/vault-entry-services.js';
import type { IGraphReader } from '../../src/lib/obsidian/graph-reader.js';
import type { NoteLinks } from '../../src/lib/obsidian/wikilink-graph.js';
import { VaultEntries, VaultEntryError } from '../../src/lib/vault-entry/index.js';
import { createInProcessLink } from '../../src/modules/semantic/vault-client/link.js';
import { testCtx } from './_ctx.js';

const VAULT = '/real/vault';

const LINKS: NoteLinks = {
  incoming: [{ source: 'b.md' }],
  outgoing: [{ target: 'Alpha', resolved: true, path: 'notes/Alpha.md' }],
};

function setup(overrides: Partial<IGraphReader> = {}) {
  const graph = {
    noteLinks: vi.fn(async (_path: string) => LINKS),
    backlinkCounts: vi.fn(async (paths: readonly string[]) =>
      paths.map((p) => (p === 'a.md' ? 2 : 0)),
    ),
    resolve: vi.fn(async (targets: readonly string[]) =>
      targets.map((t) => (t === 'Alpha' ? 'notes/Alpha.md' : null)),
    ),
    ...overrides,
  };
  const entries = {
    graph: vi.fn((_id: number, vault: string) => {
      if (vault !== VAULT) {
        throw new VaultEntryError('NOT_ATTACHED', `vault "${vault}" is not attached`);
      }
      return graph;
    }),
  };
  const registry = new ServiceRegistry();
  registry.register('graph', createGraphService(entries));
  let next = 1;
  const call = (method: string, params: unknown, connection = 1) => {
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: next++,
      method,
      params: params as never,
    };
    return registry.dispatch(request, testCtx(connection));
  };
  return { entries, graph, call };
}

function resultOf(response: JSONRPCMessage): unknown {
  if (!isJSONRPCResultResponse(response)) throw new Error('expected a result response');
  return response.result;
}

function errorOf(response: JSONRPCMessage) {
  if (!isJSONRPCErrorResponse(response)) throw new Error('expected an error response');
  return {
    code: (response.error.data as { code: string }).code,
    message: response.error.message,
  };
}

describe('the graph service', () => {
  it("graph.noteLinks answers the note's links from the connection's entry", async () => {
    const { call, entries, graph } = setup();
    expect(resultOf(await call('graph.noteLinks', { vault: VAULT, path: 'a.md' }, 4))).toEqual(
      LINKS,
    );
    expect(entries.graph).toHaveBeenCalledWith(4, VAULT);
    expect(graph.noteLinks).toHaveBeenCalledWith('a.md');
  });

  it('graph.backlinkCounts answers one count per path, in order', async () => {
    const { call } = setup();
    expect(
      resultOf(await call('graph.backlinkCounts', { vault: VAULT, paths: ['a.md', 'b.md'] })),
    ).toEqual({ counts: [2, 0] });
  });

  it('graph.resolve answers one path or null per target, in order', async () => {
    const { call } = setup();
    expect(
      resultOf(await call('graph.resolve', { vault: VAULT, targets: ['Alpha', 'Nowhere'] })),
    ).toEqual({ paths: ['notes/Alpha.md', null] });
  });

  it.each([
    ['graph.noteLinks', { path: 'a.md' }],
    ['graph.backlinkCounts', { paths: ['a.md'] }],
    ['graph.resolve', { targets: ['Alpha'] }],
  ])('%s answers NOT_ATTACHED for a vault the connection did not attach', async (method, own) => {
    const { call, graph } = setup();
    expect(errorOf(await call(method, { vault: '/other', ...own }))).toMatchObject({
      code: 'NOT_ATTACHED',
    });
    for (const spy of Object.values(graph)) expect(spy).not.toHaveBeenCalled();
  });

  it('a read that throws is GRAPH_FAILED with its message', async () => {
    const { call } = setup({
      backlinkCounts: async () => Promise.reject(new Error('vault entry: disposed')),
      noteLinks: async () => Promise.reject(new Error('scan exploded')),
    });
    expect(errorOf(await call('graph.backlinkCounts', { vault: VAULT, paths: ['a.md'] }))).toEqual({
      code: 'GRAPH_FAILED',
      message: 'vault entry: disposed',
    });
    expect(errorOf(await call('graph.noteLinks', { vault: VAULT, path: 'a.md' }))).toEqual({
      code: 'GRAPH_FAILED',
      message: 'scan exploded',
    });
  });

  it('malformed params are INVALID_PARAMS before the entries are asked', async () => {
    const { call, entries } = setup();
    expect(
      errorOf(await call('graph.resolve', { vault: VAULT, targets: ['A'], extra: 1 })),
    ).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(entries.graph).not.toHaveBeenCalled();
  });
});

describe('the graph service over the in-process link', () => {
  let root: string | undefined;
  let entries: VaultEntries | undefined;

  afterEach(async () => {
    await entries?.dispose();
    if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
    entries = undefined;
    root = undefined;
  });

  it('answers from the vault entry a profiles: [] attach reached', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-graph-service-'));
    await fs.writeFile(path.join(root, 'Alpha.md'), 'the target\n');
    await fs.writeFile(path.join(root, 'a.md'), 'see [[Alpha]] and [[Nowhere]]\n');
    await fs.writeFile(path.join(root, 'b.md'), 'also [[Alpha]]\n');
    entries = new VaultEntries({
      embedderFor: () => async (texts) => texts.map(() => []),
      idleTimeoutMs: 0,
      warn: () => {},
    });
    const link = createInProcessLink(createVaultEntryServices(entries));
    const { vault } = await link.request<VaultAttachResult>(
      'vault.attach',
      { vault: root, profiles: [] },
      0,
    );

    await expect(
      link.request('graph.backlinkCounts', { vault, paths: ['Alpha.md', 'a.md'] }, 0),
    ).resolves.toEqual({ counts: [2, 0] });
    await expect(
      link.request('graph.resolve', { vault, targets: ['Alpha', 'Nowhere'] }, 0),
    ).resolves.toEqual({ paths: ['Alpha.md', null] });
    await expect(link.request('graph.noteLinks', { vault, path: 'Alpha.md' }, 0)).resolves.toEqual({
      incoming: [{ source: 'a.md' }, { source: 'b.md' }],
      outgoing: [],
    });
    const refused = await link
      .request('graph.resolve', { vault, targets: ['Alpha'], extra: 1 }, 0)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonRpcError);
    expect(refused).toMatchObject({
      code: 'INVALID_PARAMS',
      message: '<root>: Unrecognized key: "extra"',
    });
    link.close();
  });
});
