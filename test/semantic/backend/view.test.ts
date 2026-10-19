import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import { CorpusNotReadyError } from '../../../src/lib/obsidian/semantic-backend.js';
import { createSemanticBackendView } from '../../../src/modules/semantic/backend/view.js';
import type { IVaultClient } from '../../../src/modules/semantic/vault-client/index.js';

const PROFILE = 'granite-97m';

function fakeClient(call?: (method: string, params: unknown) => unknown) {
  const client = {
    call: vi.fn(async (method: string, params: { anchors: unknown[] }) =>
      call ? call(method, params) : { hits: params.anchors.map(() => []) },
    ),
    status: vi.fn(async () => ({ state: 'ready' as const })),
    warm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return { client, view: createSemanticBackendView(client as unknown as IVaultClient, PROFILE) };
}

function rejecting(error: unknown) {
  return fakeClient(() => {
    throw error;
  });
}

describe('createSemanticBackendView', () => {
  it('reads send number[] anchors, the profile, and no undefined keys', async () => {
    const { client, view } = fakeClient();

    await view.nearest([{ vector: new Float32Array([1, 0]) }, { path: 'a.md' }], {
      threshold: 0.5,
      limit: undefined,
      allowed: ['a.md'],
    });
    await view.nearestBlocks([{ vector: [1, 0] }, { path: 'b.md' }], {
      paths: ['a.md'],
      threshold: 0.1,
      limit: 2,
    });

    const [nearest, blocks] = client.call.mock.calls;
    expect(nearest).toStrictEqual([
      'corpus.nearest',
      {
        profile: PROFILE,
        anchors: [{ vector: [1, 0] }, { path: 'a.md' }],
        threshold: 0.5,
        allowed: ['a.md'],
      },
    ]);
    expect(
      Array.isArray((nearest?.[1] as { anchors: { vector: unknown }[] }).anchors[0].vector),
    ).toBe(true);
    expect(blocks).toStrictEqual([
      'corpus.nearestBlocks',
      {
        profile: PROFILE,
        anchors: [{ vector: [1, 0] }, { path: 'b.md' }],
        paths: ['a.md'],
        threshold: 0.1,
        limit: 2,
      },
    ]);
  });

  it('returns the answer`s lists', async () => {
    const hit = { path: 'x.md', similarity: 0.9 };
    const { view } = fakeClient(() => ({ hits: [[hit], null] }));
    await expect(
      view.nearest([{ path: 'a.md' }, { path: 'b.md' }], { threshold: 0.1 }),
    ).resolves.toStrictEqual([[hit], null]);
  });

  it('an answer without one list per anchor is an error', async () => {
    const missing = fakeClient(() => ({}));
    await expect(missing.view.nearest([{ path: 'a.md' }], { threshold: 0.1 })).rejects.toThrow(
      'daemon answered corpus.nearest without one list per anchor',
    );
    const short = fakeClient(() => ({ hits: [[]] }));
    await expect(
      short.view.nearestBlocks([{ path: 'a.md' }, { path: 'b.md' }], {
        paths: [],
        threshold: 0.1,
      }),
    ).rejects.toThrow('daemon answered corpus.nearestBlocks without one list per anchor');
  });

  it('CORPUS_NOT_READY maps to CorpusNotReadyError with the daemon status', async () => {
    const status = { state: 'indexing', indexed: 1, total: 4 };
    const { view } = rejecting(
      new DaemonRpcError('CORPUS_NOT_READY', 'the corpus is indexing', { status }),
    );
    const error = await view
      .nearest([{ path: 'a.md' }], { threshold: 0.1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status).toStrictEqual(status);
    expect((error as CorpusNotReadyError).message).toBe('the corpus is indexing');

    const blocks = await view
      .nearestBlocks([{ path: 'a.md' }], { paths: [], threshold: 0.1 })
      .catch((e: unknown) => e);
    expect(blocks).toBeInstanceOf(CorpusNotReadyError);
    expect((blocks as CorpusNotReadyError).status).toStrictEqual(status);
  });

  it('CORPUS_NOT_READY without a status reads unavailable with the message', async () => {
    const { view } = rejecting(new DaemonRpcError('CORPUS_NOT_READY', 'not yet', {}));
    const error = await view
      .nearest([{ path: 'a.md' }], { threshold: 0.1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status).toStrictEqual({
      state: 'unavailable',
      reason: 'not yet',
    });
  });

  it('VAULT_UNAVAILABLE maps to CorpusNotReadyError unavailable with the reason', async () => {
    const { view } = rejecting(new DaemonRpcError('VAULT_UNAVAILABLE', 'cannot open the vault'));
    const error = await view
      .nearestBlocks([{ path: 'a.md' }], { paths: [], threshold: 0.1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status).toStrictEqual({
      state: 'unavailable',
      reason: 'cannot open the vault',
    });
  });

  it('CORPUS_FAILED and transport errors reach the caller as themselves', async () => {
    const failed = new DaemonRpcError('CORPUS_FAILED', 'boom');
    await expect(
      rejecting(failed).view.nearest([{ path: 'a.md' }], { threshold: 0.1 }),
    ).rejects.toBe(failed);

    const transport = new Error('socket closed');
    await expect(
      rejecting(transport).view.nearestBlocks([{ path: 'a.md' }], {
        paths: [],
        threshold: 0.1,
      }),
    ).rejects.toBe(transport);
  });

  it('status and dispose delegate', async () => {
    const { client, view } = fakeClient();
    await expect(view.status()).resolves.toStrictEqual({ state: 'ready' });
    expect(client.status).toHaveBeenCalledWith(PROFILE);
    await view.dispose();
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});
