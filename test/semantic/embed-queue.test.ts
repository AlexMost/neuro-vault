import { describe, expect, it } from 'vitest';

import { createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';

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
      initialize: async () => {},
      embed: async (text: string) => {
        order.push(text);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [1];
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
      initialize: async () => {},
      embed: async (text: string) => {
        if (text === 'bad') throw new Error('boom');
        return [2];
      },
    };
    const q = createQueuedEmbedder(failing);
    await expect(q.embedIndex('bad')).rejects.toThrow('boom');
    await expect(q.embedIndex('good')).resolves.toEqual([2]);
  });
});
