import { describe, expect, it } from 'vitest';

import { bucketByLength, createQueuedEmbedder } from '../../src/modules/semantic/embed-queue.js';
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
    void q.embedDocuments(['a']);
    void q.embedDocuments(['b']);
    await Promise.resolve();
    expect(c.order).toEqual(['a']);
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
    expect(await embedder.embedDocuments(['b'])).toEqual([[2]]);
    expect(calls).toEqual(['q:a', 'd:b']);
  });
});

describe('bucketByLength', () => {
  it('groups shortest-first, at most maxBatchSize per bucket', () => {
    const texts = Array.from({ length: 10 }, (_, i) => 'x'.repeat(10 + i));
    expect(bucketByLength(texts, 8).map((b) => b.length)).toEqual([8, 2]);
  });

  it('starts a new bucket when a text is more than twice the bucket’s shortest', () => {
    const texts = ['aaaa', 'aaaaaaaaaaaaaaaaaaaa', 'aaaaa', 'aaaaaaaaaaaaaaaaaaaaa'];
    expect(bucketByLength(texts, 8)).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it('puts a note’s long own text in a different bucket from its short blocks', () => {
    const note = 'n'.repeat(2000);
    const blocks = Array.from({ length: 6 }, () => 'b'.repeat(250));
    expect(bucketByLength([note, ...blocks], 8)).toEqual([[1, 2, 3, 4, 5, 6], [0]]);
  });

  it('returns no buckets for no texts', () => {
    expect(bucketByLength([], 8)).toEqual([]);
  });
});

/** A provider whose every call blocks until released by hand, in order. */
function gatedProvider() {
  const log: string[] = [];
  const gates: Array<() => void> = [];
  const wait = () => new Promise<void>((resolve) => gates.push(resolve));
  return {
    log,
    releaseNext: () => gates.shift()?.(),
    provider: {
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 2,
      initialize: async () => {},
      embedQuery: async (t: string) => (log.push(`q:${t}`), await wait(), [0]),
      embedDocuments: async (ts: string[]) => (
        log.push(`d:${ts.join(',')}`),
        await wait(),
        ts.map((t) => [t.length])
      ),
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('createQueuedEmbedder — batching', () => {
  it('returns vectors in input order across buckets', async () => {
    const { provider, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const result = embedder.embedDocuments(['ccc', 'a', 'bb']);
    for (let i = 0; i < 2; i++) {
      await flush();
      releaseNext();
    }
    expect(await result).toEqual([[3], [1], [2]]);
  });

  it('runs a query after the in-flight bucket and before queued ones', async () => {
    const { provider, log, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const docs = embedder.embedDocuments(['aa', 'aa', 'bbbbbbbbbb', 'bbbbbbbbbb']);
    await flush();
    const query = embedder.embedQuery('q');
    for (let i = 0; i < 3; i++) {
      await flush();
      releaseNext();
    }
    await Promise.all([docs, query]);
    expect(log).toEqual(['d:aa,aa', 'q:q', 'd:bbbbbbbbbb,bbbbbbbbbb']);
  });

  it('gives two concurrent callers their own vectors when their buckets interleave', async () => {
    const { provider, releaseNext } = gatedProvider();
    const embedder = createQueuedEmbedder(provider);
    const a = embedder.embedDocuments(['a1', 'a2', 'aaaaaaa3']);
    const b = embedder.embedDocuments(['b', 'bbbbbbbbbbbb']);
    for (let i = 0; i < 4; i++) {
      await flush();
      releaseNext();
    }
    expect(await a).toEqual([[2], [2], [8]]);
    expect(await b).toEqual([[1], [12]]);
  });

  it('a failed bucket rejects only its own call', async () => {
    let calls = 0;
    const embedder = createQueuedEmbedder({
      identity: TEST_EMBEDDING_IDENTITY,
      maxBatchSize: 8,
      initialize: async () => {},
      embedQuery: async () => [0],
      embedDocuments: async (ts) => {
        calls += 1;
        if (calls === 1) throw new Error('onnx exploded');
        return ts.map(() => [1]);
      },
    });
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow('onnx exploded');
    await expect(embedder.embedDocuments(['y'])).resolves.toEqual([[1]]);
  });
});
