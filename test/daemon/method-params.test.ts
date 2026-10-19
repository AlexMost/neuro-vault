/**
 * The method edge: every daemon method's params schema, through both paths a request takes to a
 * handler. The socket path is `ServiceRegistry.dispatch`; the in-process loopback calls the same
 * handlers directly, past `dispatch`. One table of bad params runs through both, so the loopback
 * is held to validate exactly as the socket does, and no case ever reaches the service's deps.
 */
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';

import {
  DaemonRpcError,
  ServiceRegistry,
  type ServiceHandlers,
} from '../../src/daemon/protocol.js';
import { createEmbedService } from '../../src/daemon/services/embed.js';
import { createVaultEntryServices } from '../../src/daemon/services/vault-entry-services.js';
import { identityOf, resolveModelProfile } from '../../src/lib/model-profiles.js';
import { createInProcessLink } from '../../src/modules/semantic/vault-client/link.js';
import { testCtx } from './_ctx.js';

const VAULT = '/real/vault';
const PROFILE = 'granite-97m';
const DIMS = 384;

/** Every dep a service reaches past its params, as spies: a bad-params case touches none. */
function setup() {
  const reader = {
    nearest: vi.fn(async (anchors: readonly unknown[]) => anchors.map(() => [])),
    nearestBlocks: vi.fn(async (anchors: readonly unknown[]) => anchors.map(() => [])),
  };
  const lexicalSearch = vi.fn(async () => ({
    notes: [],
    truncated: false,
    perQueryCounts: {},
    perQueryTokenCounts: {},
    totalNotes: 0,
  }));
  const entries = {
    attach: vi.fn(async (_id: number, vault: string) => ({ vault, profiles: {} })),
    status: vi.fn(() => ({ state: 'ready' as const })),
    detach: vi.fn(),
    reader: vi.fn(() => ({ reader, status: { state: 'ready' as const }, dims: DIMS })),
    lexical: vi.fn(() => ({ lexicalSearch })),
  };
  const createProvider = vi.fn(() => ({
    identity: identityOf(resolveModelProfile(PROFILE)),
    maxBatchSize: 8,
    initialize: async () => undefined,
    embedQuery: async () => new Array<number>(DIMS).fill(0.5),
    embedDocuments: async (texts: string[]) => texts.map(() => new Array<number>(DIMS).fill(0.5)),
  }));
  const services: Record<string, ServiceHandlers> = {
    embed: createEmbedService({ createProvider }).handlers,
    ...createVaultEntryServices(entries),
  };
  const untouched = () => {
    for (const spy of [...Object.values(entries), createProvider]) {
      expect(spy).not.toHaveBeenCalled();
    }
  };
  return { services, untouched };
}

/** The two ways a request reaches a handler: each settles to its result or a DaemonRpcError. */
const paths = {
  socket: async (services: Record<string, ServiceHandlers>, method: string, params: unknown) => {
    const registry = new ServiceRegistry();
    for (const [name, handlers] of Object.entries(services)) registry.register(name, handlers);
    const request: JSONRPCRequest = { jsonrpc: '2.0', id: 1, method, params: params as never };
    const response = await registry.dispatch(request, testCtx());
    if (isJSONRPCResultResponse(response)) return response.result;
    if (!isJSONRPCErrorResponse(response)) throw new Error('expected a response');
    const { code, ...data } = response.error.data as { code: DaemonRpcError['code'] };
    return new DaemonRpcError(code, response.error.message, data);
  },
  loopback: async (services: Record<string, ServiceHandlers>, method: string, params: unknown) =>
    createInProcessLink(services)
      .request(method, params as never, 0)
      .catch((error: unknown) => error),
} as const;

const vector = (length = DIMS) => new Array<number>(length).fill(0.5);

/** One valid call per method: each bad case below breaks exactly one thing in it. */
const VALID = {
  'embed.initialize': { profile: PROFILE },
  'embed.query': { profile: PROFILE, text: 'q' },
  'embed.documents': { profile: PROFILE, texts: ['t'] },
  'vault.attach': { vault: VAULT, profiles: [] },
  'vault.status': { vault: VAULT, profile: PROFILE },
  'corpus.nearest': {
    vault: VAULT,
    profile: PROFILE,
    anchors: [{ vector: vector() }],
    threshold: 0.5,
  },
  'corpus.nearestBlocks': {
    vault: VAULT,
    profile: PROFILE,
    anchors: [{ path: 'a.md' }],
    threshold: 0.5,
    paths: ['a.md'],
  },
  'lexical.search': { vault: VAULT, queries: ['q'], note_cap: 10, per_note_cap: 3 },
} as const;
type Method = keyof typeof VALID;

const without = (method: Method, key: string) => {
  const params: Record<string, unknown> = { ...VALID[method] };
  delete params[key];
  return params;
};
const withParams = (method: Method, extra: Record<string, unknown>) => ({
  ...VALID[method],
  ...extra,
});

const corpusCases = (method: 'corpus.nearest' | 'corpus.nearestBlocks') =>
  [
    ['a missing vault', without(method, 'vault')],
    ['a non-string profile', withParams(method, { profile: 3 })],
    ['a missing anchors', without(method, 'anchors')],
    ['a non-array anchors', withParams(method, { anchors: { vector: [] } })],
    ['a non-object anchor', withParams(method, { anchors: ['a.md'] })],
    ['an anchor with neither key', withParams(method, { anchors: [{}] })],
    [
      'an anchor with both keys',
      withParams(method, { anchors: [{ vector: vector(), path: 'a' }] }),
    ],
    ['an anchor with another key', withParams(method, { anchors: [{ vec: vector() }] })],
    ['a non-array vector', withParams(method, { anchors: [{ vector: 'abc' }] })],
    [
      'a null vector entry',
      withParams(method, { anchors: [{ vector: [...vector(DIMS - 1), null] }] }),
    ],
    [
      'a NaN vector entry',
      withParams(method, { anchors: [{ vector: [...vector(DIMS - 1), NaN] }] }),
    ],
    ['a non-string path anchor', withParams(method, { anchors: [{ path: 4 }] })],
    ['a missing threshold', without(method, 'threshold')],
    ['a null threshold', withParams(method, { threshold: null })],
    ['an infinite threshold', withParams(method, { threshold: Infinity })],
    ['a fractional limit', withParams(method, { limit: 1.5 })],
    ['a negative limit', withParams(method, { limit: -1 })],
    ['an unknown key', withParams(method, { extra: 1 })],
    ['a camelCase key', withParams(method, { nearestBlocks: true })],
  ] as const;

const CASES: ReadonlyArray<readonly [Method, string, unknown]> = [
  ...(['embed.initialize', 'embed.query', 'embed.documents'] as const).flatMap((method) => [
    [method, 'no params', undefined] as const,
    [method, 'array params', [PROFILE]] as const,
    [method, 'a missing profile', without(method, 'profile')] as const,
    [method, 'a non-string profile', withParams(method, { profile: 1 })] as const,
    [method, 'an unexpected key', withParams(method, { model: 'x' })] as const,
  ]),
  ['embed.query', 'a missing text', without('embed.query', 'text')],
  ['embed.query', 'a blank text', withParams('embed.query', { text: '  \n' })],
  ['embed.query', 'a prefix key', withParams('embed.query', { prefix: 'query: ' })],
  ['embed.documents', 'an empty texts', withParams('embed.documents', { texts: [] })],
  ['embed.documents', 'a non-array texts', withParams('embed.documents', { texts: 't' })],
  ['embed.documents', 'a non-string text', withParams('embed.documents', { texts: ['a', 2] })],
  ['embed.documents', 'a blank document', withParams('embed.documents', { texts: ['a', ' '] })],
  ['embed.documents', 'a batch key', withParams('embed.documents', { batch: 2 })],

  ['vault.attach', 'no params', undefined],
  ['vault.attach', 'a missing vault', without('vault.attach', 'vault')],
  ['vault.attach', 'a non-string vault', withParams('vault.attach', { vault: 3 })],
  ['vault.attach', 'a relative vault', withParams('vault.attach', { vault: 'relative/vault' })],
  ['vault.attach', 'a missing profiles', without('vault.attach', 'profiles')],
  ['vault.attach', 'a non-array profiles', withParams('vault.attach', { profiles: PROFILE })],
  ['vault.attach', 'a non-string profile', withParams('vault.attach', { profiles: [PROFILE, 4] })],
  ['vault.attach', 'a scope key', withParams('vault.attach', { scope: { exclude: ['x'] } })],
  ['vault.attach', 'an exclusions key', withParams('vault.attach', { exclusions: [] })],
  ['vault.attach', 'a corpus identity key', withParams('vault.attach', { identity: {} })],
  ['vault.status', 'no params', undefined],
  ['vault.status', 'a missing vault', without('vault.status', 'vault')],
  ['vault.status', 'a non-string vault', withParams('vault.status', { vault: 1 })],
  ['vault.status', 'a missing profile', without('vault.status', 'profile')],
  ['vault.status', 'a non-string profile', withParams('vault.status', { profile: [PROFILE] })],
  ['vault.status', 'a scope key', withParams('vault.status', { scope: {} })],

  ...corpusCases('corpus.nearest').map(
    ([label, params]) => ['corpus.nearest', label, params] as const,
  ),
  ['corpus.nearest', 'no params', undefined],
  ['corpus.nearest', 'a non-array allowed', withParams('corpus.nearest', { allowed: 'a.md' })],
  ['corpus.nearest', 'a non-string allowed', withParams('corpus.nearest', { allowed: [1] })],
  ['corpus.nearest', 'a non-string exclude', withParams('corpus.nearest', { exclude: [null] })],
  [
    'corpus.nearest',
    'paths, which is nearestBlocks’',
    withParams('corpus.nearest', { paths: ['a'] }),
  ],
  ...corpusCases('corpus.nearestBlocks').map(
    ([label, params]) => ['corpus.nearestBlocks', label, params] as const,
  ),
  ['corpus.nearestBlocks', 'a missing paths', without('corpus.nearestBlocks', 'paths')],
  ['corpus.nearestBlocks', 'a non-array paths', withParams('corpus.nearestBlocks', { paths: 'a' })],
  ['corpus.nearestBlocks', 'a non-string path', withParams('corpus.nearestBlocks', { paths: [1] })],
  [
    'corpus.nearestBlocks',
    'allowed, which is nearest’s',
    withParams('corpus.nearestBlocks', { allowed: [] }),
  ],
  [
    'corpus.nearestBlocks',
    'exclude, which is nearest’s',
    withParams('corpus.nearestBlocks', { exclude: [] }),
  ],

  ['lexical.search', 'non-object params', ['x']],
  ['lexical.search', 'a missing vault', without('lexical.search', 'vault')],
  ['lexical.search', 'a profile key', withParams('lexical.search', { profile: PROFILE })],
  ['lexical.search', 'empty queries', withParams('lexical.search', { queries: [] })],
  ['lexical.search', 'queries not an array', withParams('lexical.search', { queries: 'q' })],
  ['lexical.search', 'a non-string query', withParams('lexical.search', { queries: ['q', 1] })],
  ['lexical.search', 'note_cap 0', withParams('lexical.search', { note_cap: 0 })],
  ['lexical.search', 'a fractional note_cap', withParams('lexical.search', { note_cap: 1.5 })],
  ['lexical.search', 'a missing per_note_cap', without('lexical.search', 'per_note_cap')],
  ['lexical.search', 'a negative per_note_cap', withParams('lexical.search', { per_note_cap: -1 })],
  ['lexical.search', 'allowed a string', withParams('lexical.search', { allowed: 'x' })],
  [
    'lexical.search',
    'allowed with a non-string',
    withParams('lexical.search', { allowed: ['a', 2] }),
  ],
];

describe.each(Object.entries(paths))('the method edge over the %s path', (_name, request) => {
  it.each(Object.entries(VALID))('accepts the valid %s call', async (method, params) => {
    const { services } = setup();
    expect(await request(services, method, params)).not.toBeInstanceOf(DaemonRpcError);
  });

  it.each(CASES)('%s: %s is INVALID_PARAMS with its issues', async (method, _label, params) => {
    const { services, untouched } = setup();
    const error = await request(services, method, params);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect(error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: {
        issues: expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]),
      },
    });
    untouched();
  });

  it('names the field and the rule in the message', async () => {
    const { services } = setup();
    expect(
      await request(services, 'vault.attach', withParams('vault.attach', { vault: 'rel' })),
    ).toMatchObject({ message: 'vault: must be an absolute path' });
    expect(
      await request(
        services,
        'embed.documents',
        withParams('embed.documents', { texts: ['a', ''] }),
      ),
    ).toMatchObject({ message: 'texts.1: must not be blank' });
    expect(
      await request(services, 'lexical.search', withParams('lexical.search', { x: 1 })),
    ).toMatchObject({
      message: '<root>: Unrecognized key: "x"',
    });
  });
});
