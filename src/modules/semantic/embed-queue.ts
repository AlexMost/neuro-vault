import type { EmbeddingProvider, QueryEmbedder } from './types.js';

interface QueueEntry {
  /** Never rejects: the outcome is already routed to the caller's promise. */
  work: () => Promise<void>;
}

export interface QueuedEmbedder {
  initialize(): Promise<void>;
  /** Query lane — jumps ahead of every queued indexing batch. */
  embedQuery(text: string): Promise<number[]>;
  /** Indexing lane — one entry per length bucket, FIFO behind every pending query. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** `QueryEmbedder` view for the retrieval path. */
  asProvider(): QueryEmbedder;
  /** Document-embed view for `reconcileCorpus`. */
  asDocumentEmbedFn(): (texts: string[]) => Promise<number[][]>;
  /** Single-text view, kept until reconcile takes the batch port. */
  asIndexEmbedFn(): (text: string) => Promise<number[]>;
}

/**
 * Groups text indices shortest-first into buckets of at most `maxBatchSize`
 * whose longest text is at most twice the shortest (design D6). A note's own
 * text contains all its blocks, so it is nearly always its longest input;
 * batching it with them would pad every block to its length.
 */
export function bucketByLength(texts: readonly string[], maxBatchSize: number): number[][] {
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length || a - b);
  const buckets: number[][] = [];
  let current: number[] = [];
  for (const index of order) {
    const shortest = current[0];
    const full = current.length >= maxBatchSize;
    const tooLong = shortest !== undefined && texts[index].length > 2 * texts[shortest].length;
    if (current.length > 0 && (full || tooLong)) {
      buckets.push(current);
      current = [];
    }
    current.push(index);
  }
  if (current.length > 0) buckets.push(current);
  return buckets;
}

/**
 * Serializes embedding work onto one provider, process-wide (design D7): one
 * forward pass at a time. Queries always drain first, so a search issued mid
 * cold-index waits for at most the one batch in flight.
 */
export function createQueuedEmbedder(provider: EmbeddingProvider): QueuedEmbedder {
  const queryLane: QueueEntry[] = [];
  const indexLane: QueueEntry[] = [];
  let running = false;

  function pump(): void {
    if (running) return;
    const entry = (queryLane.length > 0 ? queryLane : indexLane).shift();
    if (!entry) return;
    running = true;
    void entry.work().finally(() => {
      running = false;
      pump();
    });
  }

  function enqueue<T>(lane: QueueEntry[], work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      lane.push({ work: () => work().then(resolve, reject) });
      pump();
    });
  }

  function embedQuery(text: string): Promise<number[]> {
    return enqueue(queryLane, () => provider.embedQuery(text));
  }

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    const vectors = new Array<number[]>(texts.length);
    await Promise.all(
      bucketByLength(texts, provider.maxBatchSize).map(async (bucket) => {
        const batch = await enqueue(indexLane, () =>
          provider.embedDocuments(bucket.map((i) => texts[i])),
        );
        if (batch.length !== bucket.length) {
          throw new Error(`provider returned ${batch.length} vectors for ${bucket.length} texts`);
        }
        bucket.forEach((textIndex, k) => {
          vectors[textIndex] = batch[k]!;
        });
      }),
    );
    return vectors;
  }

  return {
    initialize: () => provider.initialize(),
    embedQuery,
    embedDocuments,
    asProvider: () => ({ initialize: () => provider.initialize(), embedQuery }),
    asDocumentEmbedFn: () => embedDocuments,
    asIndexEmbedFn: () => async (text) => {
      const [vector] = await embedDocuments([text]);
      return vector;
    },
  };
}
