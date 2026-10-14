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
}

/**
 * Groups text indices shortest-first into buckets of at most `maxBatchSize`
 * whose longest text is at most twice the shortest (design D6), so no input is
 * padded to one far longer. A note's inputs differ widely in length — its
 * blocks among themselves, and the note text (which holds them all) from each
 * of them — and which one is longest is not fixed: a block's heading
 * breadcrumbs can make it outrun a note that is little more than that block.
 * So the buckets come from measured lengths, not from input order.
 *
 * Lengths are clamped at `lengthCap`: past it every text fills the model's
 * token window, so a 6 000- and a 60 000-character note pad to the same width
 * and belong in one bucket.
 */
export function bucketByLength(
  texts: readonly string[],
  maxBatchSize: number,
  lengthCap = Infinity,
): number[][] {
  const length = (i: number): number => Math.min(texts[i].length, lengthCap);
  const order = texts.map((_, i) => i).sort((a, b) => length(a) - length(b) || a - b);
  const buckets: number[][] = [];
  let current: number[] = [];
  for (const index of order) {
    const shortest = current[0];
    const full = current.length >= maxBatchSize;
    const tooLong = shortest !== undefined && length(index) > 2 * length(shortest);
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
 * Characters per window token past which a text surely fills the window, for
 * bucketing only: prose runs 1.6–2.9 characters per token. A text misjudged by
 * it costs padding, never a different vector — the tokenizer still decides
 * what reaches the model (design D9).
 */
const WINDOW_FILL_CHARS_PER_TOKEN = 4;

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
      // The Promise executor runs `work` synchronously and turns a synchronous
      // throw into a rejection, so `entry.work()` itself never throws and `pump`
      // can never be left with `running` stuck on.
      lane.push({ work: () => new Promise<T>((done) => done(work())).then(resolve, reject) });
      pump();
    });
  }

  function embedQuery(text: string): Promise<number[]> {
    return enqueue(queryLane, () => provider.embedQuery(text));
  }

  async function embedDocuments(texts: string[]): Promise<number[][]> {
    // Checked here, not left to the provider: it sees bucket-local indices.
    const blank = texts.findIndex((text) => text.trim() === '');
    if (blank !== -1) throw new Error(`document ${blank} is blank`);

    const vectors = new Array<number[]>(texts.length);
    // Once one bucket fails the call has failed: its still-queued buckets skip
    // the forward pass instead of computing vectors nobody will read.
    let failed = false;
    await Promise.all(
      bucketByLength(
        texts,
        provider.maxBatchSize,
        provider.identity.max_tokens * WINDOW_FILL_CHARS_PER_TOKEN,
      ).map(async (bucket) => {
        try {
          const batch = await enqueue(indexLane, () =>
            failed
              ? Promise.reject(new Error('skipped: another batch of this call failed'))
              : provider.embedDocuments(bucket.map((i) => texts[i])),
          );
          if (batch.length !== bucket.length) {
            throw new Error(`provider returned ${batch.length} vectors for ${bucket.length} texts`);
          }
          bucket.forEach((textIndex, k) => {
            vectors[textIndex] = batch[k]!;
          });
        } catch (error) {
          failed = true;
          throw error;
        }
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
  };
}
