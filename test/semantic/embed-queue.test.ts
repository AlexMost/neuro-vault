import { describe, expect, it } from 'vitest';

import { createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';
import { TEST_EMBEDDING_IDENTITY } from '../_identity.js';

/** A provider whose in-flight embed is released by hand. */
function controllableProvider() {
  const order: string[] = [];
  let release: (() => void) | null = null;
  return {
    order,
    releaseOne(): void {
      const fn = release;
      release = null;
      fn?.();
    },
    provider: {
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async (text: string) => {
        order.push(text);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [1];
      },
      embedDocuments: async (texts: string[]) => {
        order.push(...texts);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return texts.map(() => [1]);
      },
    },
  };
}

describe('createQueuedEmbedder', () => {
  it('runs one embed at a time', async () => {
    const c = controllableProvider();
    const q = createQueuedEmbedder(c.provider);
    void q.embedIndex('a');
    void q.embedIndex('b');
    await Promise.resolve();
    expect(c.order).toEqual(['a']);
  });

  it('serves a query ahead of queued indexing work', async () => {
    const c = controllableProvider();
    const q = createQueuedEmbedder(c.provider);
    const first = q.embedIndex('index-1');
    void q.embedIndex('index-2');
    void q.embedQuery('query');
    c.releaseOne(); // finish index-1
    await first;
    await Promise.resolve();
    expect(c.order).toEqual(['index-1', 'query']);
  });

  it('a rejected embed does not wedge the queue', async () => {
    const failing = {
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async () => [2],
      embedDocuments: async (texts: string[]) => {
        if (texts.includes('bad')) throw new Error('boom');
        return texts.map(() => [2]);
      },
    };
    const q = createQueuedEmbedder(failing);
    await expect(q.embedIndex('bad')).rejects.toThrow('boom');
    await expect(q.embedIndex('good')).resolves.toEqual([2]);
  });

  it('routes the query lane to embedQuery and the index lane to embedDocuments', async () => {
    const calls: string[] = [];
    const embedder = createQueuedEmbedder({
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async (t) => (calls.push(`q:${t}`), [1]),
      embedDocuments: async (ts) => (calls.push(`d:${ts.join(',')}`), ts.map(() => [2])),
    });
    expect(await embedder.embedQuery('a')).toEqual([1]);
    expect(await embedder.embedIndex('b')).toEqual([2]);
    expect(calls).toEqual(['q:a', 'd:b']);
  });
});
