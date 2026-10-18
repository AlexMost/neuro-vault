import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import { ServiceRegistry } from '../../src/daemon/protocol.js';
import { createCorpusService } from '../../src/daemon/services/corpus.js';
import type { ICorpusReader } from '../../src/lib/obsidian/corpus/corpus.js';
import type { BackendStatus } from '../../src/lib/obsidian/semantic-backend.js';
import { VaultEntryError } from '../../src/lib/vault-entry/index.js';
import { testCtx } from './_ctx.js';

const VAULT = '/real/vault';
const PROFILE = 'granite-97m';
const DIMS = 384;

function fakeReader() {
  return {
    nearest: vi.fn(async (anchors: readonly unknown[]) =>
      anchors.map(() => [{ path: 'a.md', similarity: 0.9 }]),
    ),
    nearestBlocks: vi.fn(async (anchors: readonly unknown[]) =>
      anchors.map(() => [
        { path: 'a.md', heading: 'h', lines: [1, 2] as [number, number], similarity: 0.9 },
      ]),
    ),
  } satisfies ICorpusReader;
}

function setup(opts: { status?: BackendStatus; reader?: ICorpusReader } = {}) {
  const reader = opts.reader ?? fakeReader();
  const status = opts.status ?? { state: 'ready' };
  const entries = {
    reader: vi.fn((_id: number, vault: string, profile: string) => {
      if (vault !== VAULT || profile !== PROFILE) {
        throw new VaultEntryError('NOT_ATTACHED', `vault "${vault}" is not attached`);
      }
      return { reader, status, dims: DIMS };
    }),
  };
  const registry = new ServiceRegistry();
  registry.register('corpus', createCorpusService(entries));
  let next = 1;
  const call = (method: string, params?: unknown, connection = 1) => {
    const request: JSONRPCRequest = { jsonrpc: '2.0', id: next++, method, params: params as never };
    return registry.dispatch(request, testCtx(connection));
  };
  return { reader, entries, call };
}

function errorOf(response: JSONRPCMessage) {
  if (!isJSONRPCErrorResponse(response)) throw new Error('expected an error response');
  return {
    code: (response.error.data as { code: string }).code,
    data: response.error.data as Record<string, unknown>,
    message: response.error.message,
  };
}

function resultOf(response: JSONRPCMessage): unknown {
  if (!isJSONRPCResultResponse(response)) throw new Error('expected a result response');
  return response.result;
}

const vector = (length = DIMS) => new Array<number>(length).fill(0.5);
const base = { vault: VAULT, profile: PROFILE, anchors: [{ vector: vector() }], threshold: 0.5 };
const blocksBase = { ...base, paths: ['a.md'] };

describe.each([
  ['corpus.nearest', base, 'nearest'],
  ['corpus.nearestBlocks', blocksBase, 'nearestBlocks'],
] as const)('%s', (method, valid, readerMethod) => {
  it("answers the reader's lists as { hits }", async () => {
    const { call, reader, entries } = setup();
    const response = await call(method, {
      ...valid,
      anchors: [{ vector: vector() }, { path: 'b.md' }],
    });
    expect(entries.reader).toHaveBeenCalledWith(1, VAULT, PROFILE);
    expect(reader[readerMethod]).toHaveBeenCalledWith(
      [{ vector: vector() }, { path: 'b.md' }],
      expect.objectContaining({ threshold: 0.5 }),
    );
    expect(resultOf(response)).toMatchObject({ hits: [expect.any(Array), expect.any(Array)] });
  });

  it.each([
    ['no params', undefined],
    ['a missing vault', { ...valid, vault: undefined }],
    ['a non-string profile', { ...valid, profile: 3 }],
    ['a missing anchors', { ...valid, anchors: undefined }],
    ['a non-array anchors', { ...valid, anchors: { vector: [] } }],
    ['a non-object anchor', { ...valid, anchors: ['a.md'] }],
    ['an anchor with neither key', { ...valid, anchors: [{}] }],
    ['an anchor with both keys', { ...valid, anchors: [{ vector: vector(), path: 'a.md' }] }],
    ['an anchor with another key', { ...valid, anchors: [{ vec: vector() }] }],
    ['a non-array vector', { ...valid, anchors: [{ vector: 'abc' }] }],
    ['a non-finite vector entry', { ...valid, anchors: [{ vector: [...vector(DIMS - 1), null] }] }],
    ['a non-string path', { ...valid, anchors: [{ path: 4 }] }],
    ['a missing threshold', { ...valid, threshold: undefined }],
    ['a non-finite threshold', { ...valid, threshold: null }],
    ['a fractional limit', { ...valid, limit: 1.5 }],
    ['a negative limit', { ...valid, limit: -1 }],
    ['an unknown key', { ...valid, extra: 1 }],
    ['a camelCase key', { ...valid, nearestBlocks: true }],
  ])('rejects %s as INVALID_PARAMS', async (_name, params) => {
    const { call, entries } = setup();
    expect(errorOf(await call(method, params)).code).toBe('INVALID_PARAMS');
    expect(entries.reader).not.toHaveBeenCalled();
  });

  it('checks the profile before the attachment: UNKNOWN_PROFILE', async () => {
    const { call, entries } = setup();
    expect(errorOf(await call(method, { ...valid, profile: 'bge-m3' })).code).toBe(
      'UNKNOWN_PROFILE',
    );
    expect(errorOf(await call(method, { ...valid, profile: 'toString' })).code).toBe(
      'UNKNOWN_PROFILE',
    );
    expect(entries.reader).not.toHaveBeenCalled();
  });

  it('answers NOT_ATTACHED for a pair the connection did not attach', async () => {
    const { call } = setup();
    expect(errorOf(await call(method, { ...valid, vault: '/other' })).code).toBe('NOT_ATTACHED');
    expect(errorOf(await call(method, { ...valid, profile: 'harrier-270m' })).code).toBe(
      'NOT_ATTACHED',
    );
  });

  it.each<BackendStatus>([
    { state: 'indexing', indexed: 2, total: 9 },
    { state: 'unavailable', reason: 'vault gone' },
    { state: 'disabled' },
  ])('answers CORPUS_NOT_READY with the status for %j', async (status) => {
    const { call, reader } = setup({ status });
    const error = errorOf(await call(method, valid));
    expect(error.code).toBe('CORPUS_NOT_READY');
    expect(error.data.status).toEqual(status);
    expect(reader[readerMethod]).not.toHaveBeenCalled();
  });

  it('answers INVALID_PARAMS for a vector whose length is not the corpus dimension', async () => {
    const { call, reader } = setup();
    const error = errorOf(
      await call(method, {
        ...valid,
        anchors: [{ path: 'a.md' }, { vector: vector(DIMS) }, { vector: vector(640) }],
      }),
    );
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toContain('640');
    expect(reader[readerMethod]).not.toHaveBeenCalled();
  });

  it('answers CORPUS_FAILED with the reason when the read throws', async () => {
    const reader = fakeReader();
    reader[readerMethod].mockRejectedValue(new Error('shard unreadable'));
    const { call } = setup({ reader });
    const error = errorOf(await call(method, valid));
    expect(error.code).toBe('CORPUS_FAILED');
    expect(error.message).toContain('shard unreadable');
  });

  it('answers an empty list of anchors with no hits', async () => {
    const { call } = setup();
    expect(resultOf(await call(method, { ...valid, anchors: [] }))).toEqual({ hits: [] });
  });
});

describe('corpus.nearest options', () => {
  it('passes threshold, limit, allowed and exclude to the reader, and null through', async () => {
    const reader = fakeReader();
    reader.nearest.mockResolvedValue([null, []] as never);
    const { call } = setup({ reader });
    const response = await call('corpus.nearest', {
      ...base,
      anchors: [{ path: 'short.md' }, { vector: vector() }],
      limit: 3,
      allowed: ['a.md', 'b.md'],
      exclude: ['c.md'],
    });
    expect(reader.nearest).toHaveBeenCalledWith(expect.any(Array), {
      threshold: 0.5,
      limit: 3,
      allowed: ['a.md', 'b.md'],
      exclude: ['c.md'],
    });
    expect(resultOf(response)).toEqual({ hits: [null, []] });
  });

  it('leaves out the options the call did not send', async () => {
    const { call, reader } = setup();
    await call('corpus.nearest', base);
    expect(reader.nearest).toHaveBeenCalledWith(expect.any(Array), { threshold: 0.5 });
  });

  it.each([
    ['allowed', { allowed: 'a.md' }],
    ['allowed', { allowed: [1] }],
    ['exclude', { exclude: [null] }],
  ])('rejects a malformed %s', async (_name, extra) => {
    const { call } = setup();
    expect(errorOf(await call('corpus.nearest', { ...base, ...extra })).code).toBe(
      'INVALID_PARAMS',
    );
  });

  it('does not accept paths, which belong to nearestBlocks', async () => {
    const { call } = setup();
    expect(errorOf(await call('corpus.nearest', { ...base, paths: ['a.md'] })).code).toBe(
      'INVALID_PARAMS',
    );
  });
});

describe('corpus.nearestBlocks options', () => {
  it('passes paths, threshold and limit to the reader', async () => {
    const { call, reader } = setup();
    await call('corpus.nearestBlocks', { ...blocksBase, paths: ['a.md', 'b.md'], limit: 2 });
    expect(reader.nearestBlocks).toHaveBeenCalledWith(expect.any(Array), {
      paths: ['a.md', 'b.md'],
      threshold: 0.5,
      limit: 2,
    });
  });

  it.each([
    ['a missing paths', { paths: undefined }],
    ['a non-array paths', { paths: 'a.md' }],
    ['a non-string path', { paths: [1] }],
    ['allowed, which belongs to nearest', { allowed: ['a.md'] }],
    ['exclude, which belongs to nearest', { exclude: ['a.md'] }],
  ])('rejects %s', async (_name, extra) => {
    const { call } = setup();
    expect(errorOf(await call('corpus.nearestBlocks', { ...blocksBase, ...extra })).code).toBe(
      'INVALID_PARAMS',
    );
  });
});
