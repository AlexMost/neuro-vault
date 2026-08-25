import type { EmbeddingProvider } from './types.js';

interface QueueEntry {
  text: string;
  resolve: (value: number[]) => void;
  reject: (reason: unknown) => void;
}

export interface QueuedEmbedder {
  initialize(): Promise<void>;
  /** Query lane — jumps ahead of queued indexing work. */
  embedQuery(text: string): Promise<number[]>;
  /** Indexing lane — FIFO behind every pending query. */
  embedIndex(text: string): Promise<number[]>;
  /** `EmbeddingProvider` view for the retrieval path. */
  asProvider(): EmbeddingProvider;
  /** `EmbedFn` view for `reconcileCorpus`. */
  asIndexEmbedFn(): (text: string) => Promise<number[]>;
}

/**
 * Serializes embed calls onto a single provider instance, process-wide.
 *
 * One embed runs at a time (design D7: the ONNX pipeline is shared by the
 * whole process). Two lanes feed it — `queryLane` always drains first, so a
 * search issued mid cold-index does not wait behind thousands of queued
 * indexing embeds.
 */
export function createQueuedEmbedder(provider: EmbeddingProvider): QueuedEmbedder {
  const queryLane: QueueEntry[] = [];
  const indexLane: QueueEntry[] = [];
  let running = false;

  function pump(): void {
    if (running) return;
    const lane = queryLane.length > 0 ? queryLane : indexLane;
    const entry = lane.shift();
    if (!entry) return;

    running = true;
    void run(entry);
  }

  async function run(entry: QueueEntry): Promise<void> {
    try {
      const vector = await provider.embed(entry.text);
      entry.resolve(vector);
    } catch (error) {
      entry.reject(error);
    } finally {
      running = false;
      pump();
    }
  }

  function enqueue(lane: QueueEntry[], text: string): Promise<number[]> {
    return new Promise<number[]>((resolve, reject) => {
      lane.push({ text, resolve, reject });
      pump();
    });
  }

  function embedQuery(text: string): Promise<number[]> {
    return enqueue(queryLane, text);
  }

  function embedIndex(text: string): Promise<number[]> {
    return enqueue(indexLane, text);
  }

  return {
    initialize: () => provider.initialize(),
    embedQuery,
    embedIndex,
    asProvider(): EmbeddingProvider {
      return {
        initialize: () => provider.initialize(),
        embed: embedQuery,
      };
    },
    asIndexEmbedFn(): (text: string) => Promise<number[]> {
      return embedIndex;
    },
  };
}
