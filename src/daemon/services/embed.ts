import { createQueuedEmbedder, type QueuedEmbedder } from '../../modules/semantic/embed-queue.js';
import { MODEL_PROFILES, type ModelProfile } from '../../modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from '../../modules/semantic/types.js';
import {
  asRecord,
  DaemonRpcError,
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
}

function readProfile(params: Record<string, unknown>): ModelProfile {
  const key = params.profile;
  if (typeof key !== 'string')
    throw new DaemonRpcError('INVALID_PARAMS', 'profile must be a string');
  if (!Object.hasOwn(MODEL_PROFILES, key))
    throw new DaemonRpcError('UNKNOWN_PROFILE', `unknown profile "${key}"`);
  return MODEL_PROFILES[key];
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
} {
  const loaded = new Map<string, LoadedProfile>();
  // Memo of in-flight loads so two concurrent initializes build one provider.
  // A failed load is dropped from here and never enters `loaded`, so the next
  // request builds and initializes a fresh provider.
  const loading = new Map<string, Promise<LoadedProfile>>();

  function get(profile: ModelProfile): Promise<LoadedProfile> {
    const ready = loaded.get(profile.key);
    if (ready) return Promise.resolve(ready);
    const pending = loading.get(profile.key);
    if (pending) return pending;
    const load = failedAs(async () => {
      const provider = deps.createProvider(profile);
      await provider.initialize();
      const entry: LoadedProfile = { provider, queue: createQueuedEmbedder(provider) };
      loaded.set(profile.key, entry);
      return entry;
    }).finally(() => loading.delete(profile.key));
    loading.set(profile.key, load);
    return load;
  }

  const handlers: ServiceHandlers = {
    initialize: async (params): Promise<EmbedInitializeResult> => {
      const { provider } = await get(readProfile(asRecord(params)));
      return { identity: provider.identity, max_batch_size: provider.maxBatchSize };
    },
    query: async (params): Promise<EmbedQueryResult> => {
      const record = asRecord(params);
      const profile = readProfile(record);
      const text = record.text;
      if (typeof text !== 'string' || text.trim() === '') {
        throw new DaemonRpcError('INVALID_PARAMS', 'text must be a non-blank string');
      }
      const { queue } = await get(profile);
      return { vector: assertFinite(await failedAs(() => queue.embedQuery(text))) };
    },
    documents: async (params): Promise<EmbedDocumentsResult> => {
      const record = asRecord(params);
      const profile = readProfile(record);
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
      const vectors = await failedAs(() => queue.embedDocuments(texts));
      return { vectors: vectors.map(assertFinite) };
    },
  };

  return { handlers, loaded: () => [...loaded.keys()] };
}
