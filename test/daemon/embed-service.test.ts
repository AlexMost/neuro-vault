import { describe, expect, it, vi } from 'vitest';
import { createEmbedService } from '../../src/daemon/services/embed.js';
import { DaemonRpcError } from '../../src/daemon/protocol.js';
import { identityOf, resolveModelProfile } from '../../src/modules/semantic/model-profiles.js';
import type { EmbeddingProvider } from '../../src/modules/semantic/types.js';

function fakeProvider(
  key: string,
  opts: { failInit?: string; vector?: number[] } = {},
): EmbeddingProvider {
  const profile = resolveModelProfile(key);
  return {
    identity: identityOf(profile),
    maxBatchSize: 8,
    initialize: vi.fn(async () => {
      if (opts.failInit) throw new Error(opts.failInit);
    }),
    embedQuery: vi.fn(async () => opts.vector ?? [1, 0, 0]),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => [0, 1, 0])),
  };
}

describe('embed service', () => {
  it('builds one provider per profile, however many clients initialize it', async () => {
    const createProvider = vi.fn((profile) => fakeProvider(profile.key));
    const service = createEmbedService({ createProvider });
    const [a, b] = await Promise.all([
      service.handlers.initialize({ profile: 'granite-97m' }),
      service.handlers.initialize({ profile: 'granite-97m' }),
    ]);
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      max_batch_size: 8,
      identity: { model_key: 'granite-97m', dims: 384 },
    });
    expect(service.loaded()).toEqual(['granite-97m']);
  });

  it('holds two providers for two profiles', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await service.handlers.initialize({ profile: 'granite-97m' });
    await service.handlers.initialize({ profile: 'harrier-270m' });
    expect(service.loaded().sort()).toEqual(['granite-97m', 'harrier-270m']);
  });

  it('rejects an unknown profile', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await expect(service.handlers.query({ profile: 'bge-m3', text: 'x' })).rejects.toMatchObject({
      code: 'UNKNOWN_PROFILE',
    });
  });

  it('reports a load failure as EMBED_FAILED and retries next time', async () => {
    let fail = true;
    const createProvider = vi.fn((p: { key: string }) =>
      fakeProvider(p.key, { failInit: fail ? 'no weights' : undefined }),
    );
    const service = createEmbedService({ createProvider });
    await expect(service.handlers.initialize({ profile: 'granite-97m' })).rejects.toMatchObject({
      code: 'EMBED_FAILED',
      message: 'no weights',
    });
    expect(service.loaded()).toEqual([]);
    fail = false;
    await expect(service.handlers.initialize({ profile: 'granite-97m' })).resolves.toMatchObject({
      max_batch_size: 8,
    });
    expect(createProvider).toHaveBeenCalledTimes(2);
  });

  it('serves query and documents, validating params', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await expect(
      service.handlers.query({ profile: 'granite-97m', text: 'hello' }),
    ).resolves.toEqual({ vector: [1, 0, 0] });
    await expect(
      service.handlers.documents({ profile: 'granite-97m', texts: ['a', 'b'] }),
    ).resolves.toEqual({
      vectors: [
        [0, 1, 0],
        [0, 1, 0],
      ],
    });
    await expect(
      service.handlers.documents({ profile: 'granite-97m', texts: ['a', ' '] }),
    ).rejects.toBeInstanceOf(DaemonRpcError);
    await expect(
      service.handlers.documents({
        profile: 'granite-97m',
        texts: new Array<string>(9).fill('t'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(service.handlers.query({ profile: 'granite-97m' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('rejects a blank query text and an empty texts array as INVALID_PARAMS', async () => {
    const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key) });
    await expect(
      service.handlers.query({ profile: 'granite-97m', text: '  \n' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      service.handlers.documents({ profile: 'granite-97m', texts: [] }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('builds the provider once when query arrives before any initialize', async () => {
    const createProvider = vi.fn((p: { key: string }) => fakeProvider(p.key));
    const service = createEmbedService({ createProvider });
    await expect(
      service.handlers.query({ profile: 'granite-97m', text: 'first' }),
    ).resolves.toEqual({ vector: [1, 0, 0] });
    await service.handlers.query({ profile: 'granite-97m', text: 'second' });
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(service.loaded()).toEqual(['granite-97m']);
  });

  it('refuses a non-finite vector', async () => {
    const service = createEmbedService({
      createProvider: (p) => fakeProvider(p.key, { vector: [Number.NaN, 0, 0] }),
    });
    await expect(
      service.handlers.query({ profile: 'granite-97m', text: 'x' }),
    ).rejects.toMatchObject({ code: 'EMBED_FAILED' });
  });

  it('serves a query ahead of queued document batches', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = fakeProvider('granite-97m');
    provider.embedDocuments = vi.fn(async (texts: string[]) => {
      order.push(`docs:${texts[0]}`);
      await gate;
      return texts.map(() => [0, 1, 0]);
    });
    provider.embedQuery = vi.fn(async () => {
      order.push('query');
      return [1, 0, 0];
    });
    const service = createEmbedService({ createProvider: () => provider });
    const d1 = service.handlers.documents({ profile: 'granite-97m', texts: ['one'] });
    const d2 = service.handlers.documents({ profile: 'granite-97m', texts: ['two'] });
    const q = service.handlers.query({ profile: 'granite-97m', text: 'q' });
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([d1, d2, q]);
    expect(order).toEqual(['docs:one', 'query', 'docs:two']);
  });
});
