import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../src/daemon/protocol.js';
import {
  DaemonConnectionError,
  type IDaemonLink,
} from '../../src/modules/semantic/daemon-connection.js';
import { DaemonEmbeddingProvider } from '../../src/modules/semantic/daemon-embedding-provider.js';
import { createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';
import { identityOf, resolveModelProfile } from '../../src/lib/model-profiles.js';
import type { ISharedServices } from '../../src/modules/semantic/shared-services.js';
import type { EmbeddingProvider } from '../../src/modules/semantic/types.js';

const profile = resolveModelProfile('granite-97m');

/** A value, or a function of the params that returns or throws one. */
type Answer = unknown;

/** A connection whose answers are per method; a function answer may throw. */
function fakeLink(answers: Record<string, Answer> = {}) {
  const link = {
    epoch: 1,
    ensure: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      const a = answers[method] ?? (method === 'embed.initialize' ? initAnswer(8) : undefined);
      return typeof a === 'function' ? (a as (p: Record<string, unknown>) => unknown)(params) : a;
    }),
  };
  return link;
}

type FakeLink = ReturnType<typeof fakeLink>;

/** The fake's `request` is not generic; the facade only ever reads what it asked for. */
const asLink = (link: FakeLink): IDaemonLink => link as unknown as IDaemonLink;

function initAnswer(maxBatchSize: number) {
  return { identity: identityOf(profile), max_batch_size: maxBatchSize };
}

function fallbackProvider(): EmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    identity: identityOf(profile),
    maxBatchSize: 3,
    initialize: async () => void calls.push('init'),
    embedQuery: async () => {
      calls.push('query');
      return [0.5];
    },
    embedDocuments: async (t) => {
      calls.push('docs');
      return t.map(() => [0.5]);
    },
  };
}

/** The process's services over a fake link; `local` makes every `ensure()` answer so. */
function fakeServices(link: FakeLink) {
  const services = {
    mode: 'pending' as ISharedServices['mode'],
    connection: asLink(link),
    ensure: vi.fn(async () => {
      if (services.mode === 'local') return 'local' as const;
      await link.ensure();
      return 'daemon' as const;
    }),
    close: vi.fn(),
  };
  return services;
}

function provider(connection: FakeLink, extra: { fallback?: EmbeddingProvider } = {}) {
  const services = fakeServices(connection);
  const createFallback = vi.fn(() => extra.fallback ?? fallbackProvider());
  const p = new DaemonEmbeddingProvider({
    profile,
    services,
    createFallback,
    initialMaxBatchSize: 8,
  });
  return Object.assign(p, { createFallback, services });
}

function methods(link: FakeLink): string[] {
  return link.request.mock.calls.map(([m]) => m);
}

describe('DaemonEmbeddingProvider — through the daemon', () => {
  it('reports the local identity and takes the batch size from embed.initialize', async () => {
    const link = fakeLink({ 'embed.initialize': initAnswer(4) });
    const p = provider(link);
    expect(p.identity).toEqual(identityOf(profile));
    expect(p.maxBatchSize).toBe(8);
    await p.initialize();
    expect(p.maxBatchSize).toBe(4);
    expect(link.request).toHaveBeenCalledWith(
      'embed.initialize',
      { profile: 'granite-97m' },
      900_000,
    );
  });

  it('embeds queries and documents with their timeouts', async () => {
    const link = fakeLink({
      'embed.query': { vector: [1, 0] },
      'embed.documents': (params: Record<string, unknown>) => ({
        vectors: (params.texts as string[]).map(() => [0, 1]),
      }),
    });
    const p = provider(link);
    await expect(p.embedQuery('hi')).resolves.toEqual([1, 0]);
    await expect(p.embedDocuments(['a'])).resolves.toEqual([[0, 1]]);
    expect(link.request).toHaveBeenCalledWith(
      'embed.query',
      { profile: 'granite-97m', text: 'hi' },
      60_000,
    );
    expect(link.request).toHaveBeenCalledWith(
      'embed.documents',
      { profile: 'granite-97m', texts: ['a'] },
      300_000,
    );
  });

  it('sends embed.initialize first on every connection, once per connection', async () => {
    const link = fakeLink({ 'embed.query': { vector: [1] } });
    const p = provider(link);
    await Promise.all([p.embedQuery('a'), p.embedQuery('b')]);
    await p.embedQuery('c');
    expect(methods(link)).toEqual([
      'embed.initialize',
      'embed.query',
      'embed.query',
      'embed.query',
    ]);
    link.epoch = 2; // reconnected
    await p.embedQuery('d');
    expect(methods(link).slice(4)).toEqual(['embed.initialize', 'embed.query']);
  });

  it('a handshake answered on a replaced connection commits nothing', async () => {
    let answer: (value: unknown) => void = () => {};
    const link = fakeLink({
      'embed.initialize': () => new Promise((resolve) => (answer = resolve)),
    });
    const p = provider(link);

    const initializing = p.initialize();
    await vi.waitFor(() => expect(methods(link)).toEqual(['embed.initialize']));
    link.epoch = 2; // reconnected while the handshake was in flight
    answer(initAnswer(2));
    await initializing;

    // The old connection's batch size is not this one's, and this one still needs its handshake.
    expect(p.maxBatchSize).toBe(8);
    link.request.mockImplementation(async () => initAnswer(4));
    await p.initialize();
    expect(methods(link)).toEqual(['embed.initialize', 'embed.initialize']);
    expect(p.maxBatchSize).toBe(4);
  });

  it('chunks a document batch larger than the daemon reports', async () => {
    const link = fakeLink({
      'embed.initialize': initAnswer(2),
      'embed.documents': (params: Record<string, unknown>) => ({
        vectors: (params.texts as string[]).map((t) => [t.length]),
      }),
    });
    const p = provider(link);
    await expect(p.embedDocuments(['a', 'bb', 'ccc'])).resolves.toEqual([[1], [2], [3]]);
    const sent = link.request.mock.calls
      .filter(([m]) => m === 'embed.documents')
      .map(([, params]) => params.texts);
    expect(sent).toEqual([['a', 'bb'], ['ccc']]);
  });

  it('sends every text once when a reconnect changes the batch size between chunks', async () => {
    // A concurrent caller reconnects while the first chunk is in flight, and
    // the new daemon reports a larger batch size. The loop must step by the
    // chunk it sent, not by the batch size it reads after the await.
    let batchSize = 2;
    let reconnected = false;
    const link: FakeLink = fakeLink({
      'embed.initialize': () => initAnswer(batchSize),
      'embed.query': { vector: [0] },
      'embed.documents': async (params: Record<string, unknown>) => {
        if (!reconnected) {
          reconnected = true;
          link.epoch = 2;
          batchSize = 3;
          await p.embedQuery('concurrent');
        }
        return { vectors: (params.texts as string[]).map((t) => [t.length]) };
      },
    });
    const p = provider(link);
    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'];
    await expect(p.embedDocuments(texts)).resolves.toEqual(texts.map((t) => [t.length]));
    const sent = link.request.mock.calls
      .filter(([m]) => m === 'embed.documents')
      .map(([, params]) => params.texts);
    expect(sent).toEqual([['a', 'bb'], ['ccc', 'dddd', 'eeeee'], ['ffffff']]);
  });

  it('rejects an answer with the wrong number of vectors', async () => {
    const link = fakeLink({ 'embed.documents': { vectors: [[1]] } });
    await expect(provider(link).embedDocuments(['a', 'b'])).rejects.toThrow(/1 vectors for 2/);
  });

  it('keeps the batch size when the daemon reports a nonsensical one', async () => {
    const link = fakeLink({ 'embed.initialize': initAnswer(0) });
    const p = provider(link);
    await p.initialize();
    expect(p.maxBatchSize).toBe(8);
  });

  it('feeds the per-process queue the daemon batch size', async () => {
    const link = fakeLink({
      'embed.initialize': initAnswer(2),
      'embed.documents': (params: Record<string, unknown>) => ({
        vectors: (params.texts as string[]).map(() => [1]),
      }),
    });
    const p = provider(link);
    await p.initialize();
    await createQueuedEmbedder(p).embedDocuments(['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']);
    const sizes = link.request.mock.calls
      .filter(([m]) => m === 'embed.documents')
      .map(([, params]) => (params.texts as string[]).length);
    expect(sizes).toEqual([2, 2, 1]);
  });
});

describe('DaemonEmbeddingProvider — errors and fallback', () => {
  it('embeds in-process once the services answer local, building the fallback once', async () => {
    const link = fakeLink();
    const fallback = fallbackProvider();
    const p = provider(link, { fallback });
    p.services.mode = 'local';
    await expect(p.embedQuery('x')).resolves.toEqual([0.5]);
    await expect(p.embedDocuments(['y'])).resolves.toEqual([[0.5]]);
    await p.initialize();
    expect(fallback.calls).toEqual(['query', 'docs', 'init']);
    expect(p.maxBatchSize).toBe(3);
    expect(link.ensure).not.toHaveBeenCalled();
    expect(link.request).not.toHaveBeenCalled();
    expect(p.createFallback).toHaveBeenCalledTimes(1);
  });

  it('builds one fallback when concurrent calls all find the services local', async () => {
    const link = fakeLink();
    const p = provider(link);
    p.services.mode = 'local';
    await Promise.all([p.embedQuery('a'), p.embedQuery('b'), p.initialize()]);
    expect(p.createFallback).toHaveBeenCalledTimes(1);
  });

  it('switches to the fallback when another facade flips the switch mid-session', async () => {
    const link = fakeLink({ 'embed.query': { vector: [1] } });
    const fallback = fallbackProvider();
    const p = provider(link, { fallback });
    await expect(p.embedQuery('a')).resolves.toEqual([1]);
    p.services.mode = 'local'; // the corpus facade found the daemon gone
    await expect(p.embedQuery('b')).resolves.toEqual([0.5]);
    expect(fallback.calls).toEqual(['query']);
  });

  it('re-sends embed.initialize when ensure() reconnected between two calls', async () => {
    const link = fakeLink({ 'embed.query': { vector: [1] } });
    link.ensure.mockImplementation(async () => {
      link.epoch += 1; // every ensure reconnects
    });
    const p = provider(link);
    await p.embedQuery('a');
    await p.embedQuery('b');
    expect(methods(link)).toEqual([
      'embed.initialize',
      'embed.query',
      'embed.initialize',
      'embed.query',
    ]);
  });

  it('does not fall back on EMBED_FAILED and retries through the daemon next time', async () => {
    const link = fakeLink({
      'embed.initialize': () => {
        throw new DaemonRpcError('EMBED_FAILED', 'no weights');
      },
    });
    const p = provider(link);
    await expect(p.initialize()).rejects.toThrow('no weights');
    await expect(p.initialize()).rejects.toThrow('no weights');
    expect(link.request).toHaveBeenCalledTimes(2);
    expect(p.createFallback).not.toHaveBeenCalled();
  });

  it('does not fall back on a dropped connection or a timeout', async () => {
    const link = fakeLink({
      'embed.query': () => {
        throw new DaemonConnectionError('daemon connection closed during embed.query');
      },
      'embed.documents': () => {
        throw new Error('daemon request embed.documents timed out after 300000 ms');
      },
    });
    const p = provider(link);
    await expect(p.embedQuery('x')).rejects.toBeInstanceOf(DaemonConnectionError);
    await expect(p.embedDocuments(['x'])).rejects.toThrow(/timed out/);
    expect(p.createFallback).not.toHaveBeenCalled();
  });
});
