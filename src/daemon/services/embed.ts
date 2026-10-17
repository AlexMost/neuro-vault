import type { EmbedDocumentsFn } from '../../lib/obsidian/corpus/types.js';
import { createQueuedEmbedder, type QueuedEmbedder } from '../../modules/semantic/embed-queue.js';
import { isProfileKey, MODEL_PROFILES, type ModelProfile } from '../../lib/model-profiles.js';
import type { EmbeddingProvider } from '../../modules/semantic/types.js';
import {
  asRecord,
  DaemonRpcError,
  onlyKeys,
  stringParam,
  type EmbedDocumentsResult,
  type EmbedInitializeResult,
  type EmbedQueryResult,
  type ServiceHandlers,
} from '../protocol.js';

interface LoadedProfile {
  provider: EmbeddingProvider;
  queue: QueuedEmbedder;
}

export interface EmbedServiceDeps {
  /** The shared provider factory in non-shared mode (design D7). */
  createProvider: (profile: ModelProfile) => EmbeddingProvider;
  /**
   * One diagnostic line, without a newline: each profile load with its time, each
   * load failure, each `EMBED_FAILED` while embedding. The daemon writes these to
   * stderr, which a spawning session redirects to `daemon.log`. Default: dropped.
   */
  log?: (line: string) => void;
  /** Milliseconds, for timing a load; default `performance.now`. */
  now?: () => number;
}

/**
 * How long `documentsFor` rejects at once after a profile failed to load. A reconcile pass embeds
 * note by note, and without this every batch would reload the model and log the failure again.
 * `embed.initialize` and `embed.query` are not held back: their next call retries.
 */
export const LOAD_FAILURE_MEMO_MS = 30_000;

function profileOf(key: string): ModelProfile {
  if (!isProfileKey(key)) throw new DaemonRpcError('UNKNOWN_PROFILE', `unknown profile "${key}"`);
  return MODEL_PROFILES[key];
}

/** The params of an `embed.*` call: exactly `profile` plus `allowed`. */
function readParams(params: unknown, ...allowed: string[]) {
  const record = asRecord(params);
  onlyKeys(record, ['profile', ...allowed]);
  return { record, profile: profileOf(stringParam(record, 'profile')) };
}

function assertFinite(vector: number[]): number[] {
  if (!vector.every((x) => Number.isFinite(x))) {
    throw new DaemonRpcError('EMBED_FAILED', 'provider returned a non-finite vector');
  }
  return vector;
}

async function failedAs<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DaemonRpcError) throw error;
    throw new DaemonRpcError(
      'EMBED_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * One provider + one cross-client queue per profile, built on first use. The
 * queue is the same `createQueuedEmbedder` a session uses, so query-first
 * ordering now holds *between* sessions, not only inside one.
 */
export function createEmbedService(deps: EmbedServiceDeps): {
  handlers: ServiceHandlers;
  loaded(): string[];
  /**
   * The documents lane of one profile's queue, for the vault entries inside this
   * process: the same load and queue `embed.documents` uses, without the wire
   * checks. The profile loads on the first call, not now.
   */
  documentsFor(profileKey: string): EmbedDocumentsFn;
} {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? (() => performance.now());
  const loaded = new Map<string, LoadedProfile>();
  // Memo of in-flight loads so two concurrent initializes build one provider.
  // A failed load is dropped from here and never enters `loaded`, so the next
  // request builds and initializes a fresh provider.
  const loading = new Map<string, Promise<LoadedProfile>>();
  // The last load failure per profile and when it happened, for `documentsFor` only.
  const loadFailures = new Map<string, { error: DaemonRpcError; at: number }>();

  function get(profile: ModelProfile): Promise<LoadedProfile> {
    const ready = loaded.get(profile.key);
    if (ready) return Promise.resolve(ready);
    const pending = loading.get(profile.key);
    if (pending) return pending;
    const started = now();
    const took = (): number => Math.round(now() - started);
    const load = failedAs(async () => {
      const provider = deps.createProvider(profile);
      await provider.initialize();
      const entry: LoadedProfile = { provider, queue: createQueuedEmbedder(provider) };
      loaded.set(profile.key, entry);
      return entry;
    })
      .then(
        (entry) => {
          log(`loaded ${profile.key} in ${took()} ms`);
          return entry;
        },
        (error: DaemonRpcError) => {
          log(`failed to load ${profile.key} after ${took()} ms: ${error.message}`);
          throw error;
        },
      )
      .finally(() => loading.delete(profile.key));
    loading.set(profile.key, load);
    return load;
  }

  /** The embedding itself; an `EMBED_FAILED` here is logged with its method and profile, never the text. */
  async function embedding<T>(what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await failedAs(work);
    } catch (error) {
      log(`${what}: ${(error as DaemonRpcError).message}`);
      throw error;
    }
  }

  const handlers: ServiceHandlers = {
    initialize: async (params): Promise<EmbedInitializeResult> => {
      const { provider } = await get(readParams(params).profile);
      return { identity: provider.identity, max_batch_size: provider.maxBatchSize };
    },
    query: async (params): Promise<EmbedQueryResult> => {
      const { record, profile } = readParams(params, 'text');
      const text = record.text;
      if (typeof text !== 'string' || text.trim() === '') {
        throw new DaemonRpcError('INVALID_PARAMS', 'text must be a non-blank string');
      }
      const { queue } = await get(profile);
      const vector = await embedding(`embed.query failed for ${profile.key}`, async () =>
        assertFinite(await queue.embedQuery(text)),
      );
      return { vector };
    },
    documents: async (params): Promise<EmbedDocumentsResult> => {
      const { record, profile } = readParams(params, 'texts');
      const texts = record.texts;
      if (!Array.isArray(texts) || !texts.every((t): t is string => typeof t === 'string')) {
        throw new DaemonRpcError('INVALID_PARAMS', 'texts must be an array of strings');
      }
      if (texts.length === 0) throw new DaemonRpcError('INVALID_PARAMS', 'texts must not be empty');
      const blank = texts.findIndex((t) => t.trim() === '');
      if (blank !== -1) throw new DaemonRpcError('INVALID_PARAMS', `document ${blank} is blank`);
      const { provider, queue } = await get(profile);
      if (texts.length > provider.maxBatchSize) {
        throw new DaemonRpcError(
          'INVALID_PARAMS',
          `at most ${provider.maxBatchSize} texts per call`,
        );
      }
      const vectors = await embedding(
        `embed.documents failed for ${profile.key} (${texts.length} texts)`,
        async () => (await queue.embedDocuments(texts)).map(assertFinite),
      );
      return { vectors };
    },
  };

  function documentsFor(profileKey: string): EmbedDocumentsFn {
    const profile = profileOf(profileKey);
    return async (texts) => {
      const failure = loadFailures.get(profile.key);
      // A profile loaded since (by `embed.initialize`) is no longer failing.
      if (failure !== undefined && !loaded.has(profile.key)) {
        if (now() - failure.at < LOAD_FAILURE_MEMO_MS) throw failure.error;
      }
      let queue: QueuedEmbedder;
      try {
        ({ queue } = await get(profile));
      } catch (error) {
        loadFailures.set(profile.key, { error: error as DaemonRpcError, at: now() });
        throw error;
      }
      loadFailures.delete(profile.key);
      return embedding(
        `embed documents failed for ${profile.key} (${texts.length} texts)`,
        async () => (await queue.embedDocuments(texts)).map(assertFinite),
      );
    };
  }

  return { handlers, loaded: () => [...loaded.keys()], documentsFor };
}
