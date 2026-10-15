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

  describe('diagnostics', () => {
    /** A clock that advances `step` ms per reading. */
    function ticking(step: number): () => number {
      let t = 1000;
      return () => {
        const now = t;
        t += step;
        return now;
      };
    }

    it('logs one line per profile load, with its time, however many clients asked', async () => {
      const log = vi.fn();
      const service = createEmbedService({
        createProvider: (p) => fakeProvider(p.key),
        log,
        now: ticking(812.4),
      });
      await Promise.all([
        service.handlers.initialize({ profile: 'granite-97m' }),
        service.handlers.query({ profile: 'granite-97m', text: 'x' }),
      ]);
      await service.handlers.initialize({ profile: 'granite-97m' });
      expect(log.mock.calls).toEqual([['loaded granite-97m in 812 ms']]);
    });

    it('logs a load failure with its message, then the retry that loads', async () => {
      const log = vi.fn();
      let fail = true;
      const service = createEmbedService({
        createProvider: (p) => fakeProvider(p.key, { failInit: fail ? 'no weights' : undefined }),
        log,
        now: ticking(5),
      });
      await expect(service.handlers.query({ profile: 'granite-97m', text: 'x' })).rejects.toThrow();
      fail = false;
      await service.handlers.initialize({ profile: 'granite-97m' });
      expect(log.mock.calls).toEqual([
        ['failed to load granite-97m after 5 ms: no weights'],
        ['loaded granite-97m in 5 ms'],
      ]);
    });

    it('logs an EMBED_FAILED inference error with its method and profile, never the text', async () => {
      const log = vi.fn();
      const provider = fakeProvider('granite-97m');
      provider.embedQuery = vi.fn(async () => {
        throw new Error('onnx exploded');
      });
      provider.embedDocuments = vi.fn(async (texts: string[]) => texts.map(() => [Number.NaN]));
      const service = createEmbedService({ createProvider: () => provider, log, now: ticking(1) });
      await service.handlers.initialize({ profile: 'granite-97m' });
      log.mockClear();
      await expect(
        service.handlers.query({ profile: 'granite-97m', text: 'secret note text' }),
      ).rejects.toMatchObject({ code: 'EMBED_FAILED' });
      await expect(
        service.handlers.documents({ profile: 'granite-97m', texts: ['a', 'b'] }),
      ).rejects.toMatchObject({ code: 'EMBED_FAILED' });
      expect(log.mock.calls).toEqual([
        ['embed.query failed for granite-97m: onnx exploded'],
        ['embed.documents failed for granite-97m (2 texts): provider returned a non-finite vector'],
      ]);
    });

    it('logs nothing for a request it rejects before embedding', async () => {
      const log = vi.fn();
      const service = createEmbedService({ createProvider: (p) => fakeProvider(p.key), log });
      await expect(service.handlers.query({ profile: 'bge-m3', text: 'x' })).rejects.toThrow();
      await expect(service.handlers.query({ profile: 'granite-97m', text: ' ' })).rejects.toThrow();
      expect(log).not.toHaveBeenCalled();
    });
  });
});
