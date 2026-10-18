import { isProfileKey } from '../../lib/model-profiles.js';
import type { CorpusAnchor, ICorpusReader } from '../../lib/obsidian/corpus/corpus.js';
import type { VaultEntries } from '../../lib/vault-entry/index.js';
import {
  asRecord,
  DaemonRpcError,
  onlyKeys,
  stringParam,
  type CorpusAnchorParam,
  type CorpusNearestBlocksResult,
  type CorpusNearestResult,
  type IConnectionContext,
  type ServiceHandlers,
} from '../protocol.js';
import { wired } from './wired.js';

/** The slice of the registry the service uses. */
export type CorpusEntriesPort = Pick<VaultEntries, 'reader'>;

const COMMON_KEYS = ['vault', 'profile', 'anchors', 'threshold', 'limit'] as const;

function invalid(message: string): DaemonRpcError {
  return new DaemonRpcError('INVALID_PARAMS', message);
}

function anchorParam(value: unknown, index: number): CorpusAnchorParam {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`anchors[${index}] must be an object`);
  }
  const keys = Object.keys(value);
  const [key] = keys;
  if (keys.length !== 1 || (key !== 'vector' && key !== 'path')) {
    throw invalid(`anchors[${index}] must have exactly one of "vector" or "path"`);
  }
  const content = (value as Record<string, unknown>)[key];
  if (key === 'path') {
    if (typeof content !== 'string') throw invalid(`anchors[${index}].path must be a string`);
    return { path: content };
  }
  if (
    !Array.isArray(content) ||
    !content.every((x) => typeof x === 'number' && Number.isFinite(x))
  ) {
    throw invalid(`anchors[${index}].vector must be an array of finite numbers`);
  }
  return { vector: content as number[] };
}

function anchorsParam(params: Record<string, unknown>): CorpusAnchorParam[] {
  const value = params.anchors;
  if (!Array.isArray(value)) throw invalid('anchors must be an array');
  return value.map(anchorParam);
}

function stringsParam(params: Record<string, unknown>, name: string): string[] {
  const value = params[name];
  if (!Array.isArray(value) || !value.every((p): p is string => typeof p === 'string')) {
    throw invalid(`${name} must be an array of strings`);
  }
  return value;
}

function optionalStringsParam(params: Record<string, unknown>, name: string): string[] | undefined {
  return params[name] === undefined ? undefined : stringsParam(params, name);
}

function thresholdParam(params: Record<string, unknown>): number {
  const value = params.threshold;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid('threshold must be a finite number');
  }
  return value;
}

function limitParam(params: Record<string, unknown>): number | undefined {
  const value = params.limit;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid('limit must be a non-negative integer');
  }
  return value;
}

/** What every `corpus.*` call carries, checked for shape only. */
interface ICall {
  vault: string;
  profile: string;
  anchors: CorpusAnchorParam[];
  threshold: number;
  limit?: number;
}

function callOf(params: Record<string, unknown>): ICall {
  const limit = limitParam(params);
  return {
    vault: stringParam(params, 'vault'),
    profile: stringParam(params, 'profile'),
    anchors: anchorsParam(params),
    threshold: thresholdParam(params),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * The reader of a call, once the corpus can serve it. The checks run in the order the answers
 * are documented: the profile is one the daemon knows (`UNKNOWN_PROFILE`), the connection
 * attached the pair (`NOT_ATTACHED`), the profile is `ready` (`CORPUS_NOT_READY`, with the
 * status), and each vector anchor is as wide as the corpus (`INVALID_PARAMS`).
 */
function readerFor(
  entries: CorpusEntriesPort,
  ctx: IConnectionContext,
  call: ICall,
): Promise<ICorpusReader> {
  return wired(() => {
    if (!isProfileKey(call.profile)) {
      throw new DaemonRpcError('UNKNOWN_PROFILE', `unknown profile "${call.profile}"`);
    }
    const { reader, status, dims } = entries.reader(ctx.id, call.vault, call.profile);
    if (status.state !== 'ready') {
      throw new DaemonRpcError(
        'CORPUS_NOT_READY',
        `the corpus of profile "${call.profile}" is ${status.state}`,
        { status },
      );
    }
    call.anchors.forEach((anchor, index) => {
      if ('vector' in anchor && anchor.vector.length !== dims) {
        throw invalid(
          `anchors[${index}].vector has ${anchor.vector.length} dimensions, the corpus has ${dims}`,
        );
      }
    });
    return reader;
  });
}

/** A read that throws inside the corpus is `CORPUS_FAILED` with the reason. */
async function reading<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DaemonRpcError(
      'CORPUS_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * `corpus.nearest` and `corpus.nearestBlocks` over the daemon's vault entries (design D9, Q10).
 * Retrieval policy stays in the session: the daemon answers one similarity read per call and
 * never a vector. The corpus yields to the event loop between the anchors of one call.
 */
export function createCorpusService(entries: CorpusEntriesPort): ServiceHandlers {
  return {
    nearest: async (params, ctx): Promise<CorpusNearestResult> => {
      const record = asRecord(params);
      onlyKeys(record, [...COMMON_KEYS, 'allowed', 'exclude']);
      const call = callOf(record);
      const allowed = optionalStringsParam(record, 'allowed');
      const exclude = optionalStringsParam(record, 'exclude');
      const reader = await readerFor(entries, ctx, call);
      const anchors: CorpusAnchor[] = call.anchors;
      const hits = await reading(() =>
        reader.nearest(anchors, {
          threshold: call.threshold,
          ...(call.limit === undefined ? {} : { limit: call.limit }),
          ...(allowed === undefined ? {} : { allowed }),
          ...(exclude === undefined ? {} : { exclude }),
        }),
      );
      return { hits };
    },
    nearestBlocks: async (params, ctx): Promise<CorpusNearestBlocksResult> => {
      const record = asRecord(params);
      onlyKeys(record, [...COMMON_KEYS, 'paths']);
      const call = callOf(record);
      const paths = stringsParam(record, 'paths');
      const reader = await readerFor(entries, ctx, call);
      const anchors: CorpusAnchor[] = call.anchors;
      const hits = await reading(() =>
        reader.nearestBlocks(anchors, {
          paths,
          threshold: call.threshold,
          ...(call.limit === undefined ? {} : { limit: call.limit }),
        }),
      );
      return { hits };
    },
  };
}
