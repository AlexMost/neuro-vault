import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import { GraphReadError } from '../../../src/lib/obsidian/graph-reader.js';
import type { NoteLinks } from '../../../src/lib/obsidian/wikilink-graph.js';
import {
  DaemonConnectionError,
  DaemonTimeoutError,
} from '../../../src/modules/semantic/daemon-connection.js';
import { createGraphReaderView } from '../../../src/modules/semantic/graph/index.js';
import { SharedServicesClosedError } from '../../../src/modules/semantic/shared-services.js';
import type { IVaultClient } from '../../../src/modules/semantic/vault-client/index.js';

const LINKS: NoteLinks = {
  incoming: [{ source: 'b.md' }],
  outgoing: [{ target: 'Nowhere', resolved: false }],
};

/** A client whose `call` answers `answer` (or throws what it throws). */
function fakeClient(answer: () => unknown) {
  const client = {
    call: vi.fn(async (_method: string, _params: Record<string, unknown>) => answer()),
    status: vi.fn(async () => ({ state: 'ready' as const })),
    warm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { client, view: createGraphReaderView(client as unknown as IVaultClient) };
}

function rejecting(error: unknown) {
  return fakeClient(() => {
    throw error;
  });
}

describe('createGraphReaderView', () => {
  it('noteLinks is one graph.noteLinks call, its answer passed through', async () => {
    const { client, view } = fakeClient(() => LINKS);
    await expect(view.noteLinks('a.md')).resolves.toEqual(LINKS);
    expect(client.call).toHaveBeenCalledExactlyOnceWith('graph.noteLinks', { path: 'a.md' });
  });

  it('backlinkCounts is one graph.backlinkCounts call over every path', async () => {
    const { client, view } = fakeClient(() => ({ counts: [2, 0] }));
    await expect(view.backlinkCounts(['a.md', 'b.md'])).resolves.toEqual([2, 0]);
    expect(client.call).toHaveBeenCalledExactlyOnceWith('graph.backlinkCounts', {
      paths: ['a.md', 'b.md'],
    });
  });

  it('resolve is one graph.resolve call over every target', async () => {
    const { client, view } = fakeClient(() => ({ paths: ['x.md', null] }));
    await expect(view.resolve(['A', 'B'])).resolves.toEqual(['x.md', null]);
    expect(client.call).toHaveBeenCalledExactlyOnceWith('graph.resolve', { targets: ['A', 'B'] });
  });

  it('an empty list asked answers at once, with no call', async () => {
    const { client, view } = fakeClient(() => {
      throw new Error('must not be called');
    });
    await expect(view.backlinkCounts([])).resolves.toEqual([]);
    await expect(view.resolve([])).resolves.toEqual([]);
    expect(client.call).not.toHaveBeenCalled();
  });

  const MALFORMED: ReadonlyArray<
    readonly [string, () => unknown, 'noteLinks' | 'backlinkCounts' | 'resolve']
  > = [
    ['a short counts list', () => ({ counts: [1] }), 'backlinkCounts'],
    ['no counts', () => ({}), 'backlinkCounts'],
    ['a non-list paths', () => ({ paths: 'x.md' }), 'resolve'],
    ['no answer', () => undefined, 'resolve'],
    ['links without incoming', () => ({ outgoing: [] }), 'noteLinks'],
  ];

  it.each(MALFORMED)('%s is a GraphReadError naming the method', async (_label, answer, read) => {
    const { view } = fakeClient(answer);
    const call =
      read === 'noteLinks'
        ? view.noteLinks('a.md')
        : read === 'backlinkCounts'
          ? view.backlinkCounts(['a.md', 'b.md'])
          : view.resolve(['A', 'B']);
    const error = await call.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphReadError);
    expect((error as Error).message).toContain(`graph.${read}`);
  });

  it.each([
    ['GRAPH_FAILED', new DaemonRpcError('GRAPH_FAILED', 'scan exploded'), /scan exploded/],
    ['NOT_ATTACHED', new DaemonRpcError('NOT_ATTACHED', 'not attached'), /not attached/],
    ['a timeout', new DaemonTimeoutError('late'), /did not answer graph\.backlinkCounts in time/],
    ['a dropped connection', new DaemonConnectionError('EPIPE'), /connection lost.*EPIPE/],
    ['closed services', new SharedServicesClosedError(), /graph\.backlinkCounts failed/],
    ['a plain throw', new Error('boom'), /graph\.backlinkCounts failed: boom/],
  ])('%s is a GraphReadError keeping the cause', async (_label, cause, message) => {
    const { view } = rejecting(cause);
    const error = await view.backlinkCounts(['a.md']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphReadError);
    expect(error).toMatchObject({ message: expect.stringMatching(message), cause });
  });
});
