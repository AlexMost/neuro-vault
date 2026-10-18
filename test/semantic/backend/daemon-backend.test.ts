import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import {
  CorpusNotReadyError,
  type BackendStatus,
  type ISemanticBackend,
} from '../../../src/lib/obsidian/semantic-backend.js';
import {
  createDaemonAttachment,
  type IVaultAttachment,
} from '../../../src/modules/semantic/backend/attachment.js';
import { createDaemonSemanticBackend } from '../../../src/modules/semantic/backend/daemon-backend.js';
import {
  DaemonConnectionError,
  DaemonTimeoutError,
  type IDaemonLink,
} from '../../../src/modules/semantic/daemon-connection.js';
import {
  createSharedServices,
  SharedServicesClosedError,
  type ISharedServices,
} from '../../../src/modules/semantic/shared-services.js';

const VAULT = '/vaults/notes';
const REAL = '/private/vaults/notes';
const PROFILE = 'granite-97m';

type Handler = (params: Record<string, unknown>) => unknown;

/** A connection answering per method; a handler may throw or return a promise. */
function fakeServices(handlers: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    'vault.attach': () => ({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } }),
    'vault.status': () => ({ state: 'ready' }),
    'corpus.nearest': (p) => ({ hits: (p.anchors as unknown[]).map(() => []) }),
    'corpus.nearestBlocks': (p) => ({ hits: (p.anchors as unknown[]).map(() => []) }),
  };
  const link = {
    epoch: 1,
    ensure: vi.fn(async () => {}),
    close: vi.fn(),
    request: vi.fn(async (method: string, params: Record<string, unknown>, _timeoutMs: number) => {
      const handler = handlers[method] ?? defaults[method];
      if (handler === undefined) throw new Error(`unexpected ${method}`);
      return handler(params);
    }),
  };
  const services = {
    mode: 'daemon' as ISharedServices['mode'],
    connection: link as unknown as IDaemonLink,
    ensure: vi.fn(async () =>
      services.mode === 'local' ? ('local' as const) : ('daemon' as const),
    ),
    close: vi.fn(),
  };
  return { services, link };
}

function methods(link: { request: { mock: { calls: unknown[][] } } }): string[] {
  return link.request.mock.calls.map(([method]) => method as string);
}

function fakeLocal(): ISemanticBackend {
  return {
    status: vi.fn(
      async (): Promise<BackendStatus> => ({ state: 'indexing', indexed: 2, total: 5 }),
    ),
    nearest: vi.fn(async () => [[{ path: 'local.md', similarity: 1 }]]),
    nearestBlocks: vi.fn(async () => [[]]),
    dispose: vi.fn(async () => {}),
  };
}

function attachmentOver(services: ISharedServices): IVaultAttachment {
  return createDaemonAttachment({ services, vaultRoot: VAULT, profiles: [PROFILE] });
}

function backendOver(
  services: ISharedServices,
  local: () => ISemanticBackend = fakeLocal,
  attachment: IVaultAttachment = attachmentOver(services),
) {
  return createDaemonSemanticBackend({ services, attachment, profile: PROFILE, local });
}

const ATTACHING = { state: 'indexing', indexed: 0, total: 0 };

/** What `promise` has settled with after one macrotask, or 'still waiting'. */
async function settledSoon<T>(promise: Promise<T>): Promise<T | 'still waiting'> {
  return Promise.race([
    promise,
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), 0)),
  ]);
}

/** Makes every `services.ensure()` wait until `decide` is called, which also sets the mode. */
function holdEnsure(services: ReturnType<typeof fakeServices>['services']) {
  let resolve: (mode: 'daemon' | 'local') => void = () => {};
  const decided = new Promise<'daemon' | 'local'>((r) => (resolve = r));
  services.ensure.mockImplementation(() => decided);
  return (mode: 'daemon' | 'local'): void => {
    services.mode = mode;
    resolve(mode);
  };
}

describe('createDaemonSemanticBackend', () => {
  it('attaches once per epoch', async () => {
    const { services, link } = fakeServices();
    const backend = backendOver(services);

    expect(await backend.status()).toEqual({ state: 'ready' });
    expect(await backend.status()).toEqual({ state: 'ready' });
    await backend.nearest([{ path: 'a.md' }], { threshold: 0.5 });

    expect(methods(link)).toEqual(['vault.attach', 'vault.status', 'corpus.nearest']);
    expect(link.request.mock.calls[0]).toEqual([
      'vault.attach',
      { vault: VAULT, profiles: [PROFILE] },
      10_000,
    ]);
    // Every call after the attach carries the realpath key the daemon answered with.
    expect(link.request.mock.calls[1]).toEqual([
      'vault.status',
      { vault: REAL, profile: PROFILE },
      10_000,
    ]);
    expect(link.request.mock.calls[2]?.[1]).toMatchObject({ vault: REAL, profile: PROFILE });
    expect(link.request.mock.calls[2]?.[2]).toBe(30_000);
  });

  it('concurrent first calls share one attach', async () => {
    const { services, link } = fakeServices();
    const backend = backendOver(services);

    await Promise.all([
      backend.nearest([{ path: 'a.md' }], { threshold: 0 }),
      backend.nearestBlocks([{ path: 'a.md' }], { paths: ['a.md'], threshold: 0 }),
    ]);

    expect(methods(link).filter((m) => m === 'vault.attach')).toHaveLength(1);
  });

  it('two facades on one attachment send one vault.attach', async () => {
    const { services, link } = fakeServices();
    const attachment = attachmentOver(services);
    const backend = backendOver(services, fakeLocal, attachment);

    // The other facade (a stub caller) attaches first; the backend finds the vault attached.
    const [other] = await Promise.all([
      attachment.key(),
      backend.nearest([{ path: 'a.md' }], { threshold: 0 }),
    ]);
    expect(other).toBe(REAL);
    expect(await backend.status()).toEqual({ state: 'ready' });

    expect(methods(link).filter((m) => m === 'vault.attach')).toHaveLength(1);
  });

  it('a first status after another facade attached reads the live status, not the attach answer', async () => {
    const { services, link } = fakeServices({
      'vault.attach': () => ({
        vault: REAL,
        profiles: { [PROFILE]: { state: 'indexing', indexed: 0, total: 3 } },
      }),
      'vault.status': () => ({ state: 'ready' }),
    });
    const attachment = attachmentOver(services);
    const backend = backendOver(services, fakeLocal, attachment);

    // The other facade attached at startup; the corpus has become ready since.
    await attachment.key();
    expect(await backend.status()).toEqual({ state: 'ready' });

    expect(methods(link)).toEqual(['vault.attach', 'vault.status']);
  });

  it('an attach answered after the epoch moved, with nothing recorded, reads attaching', async () => {
    let answerStale: (value: unknown) => void = () => {};
    const { services, link } = fakeServices({
      'vault.attach': () => new Promise((resolve) => (answerStale = resolve)),
    });
    const backend = backendOver(services);

    const stale = backend.status();
    await vi.waitFor(() => expect(link.request).toHaveBeenCalled());
    link.epoch = 2;
    answerStale({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } });

    expect(await stale).toEqual(ATTACHING);
  });

  it('re-attaches after a new epoch', async () => {
    const { services, link } = fakeServices();
    const backend = backendOver(services);
    await backend.status();

    link.epoch = 2;
    await backend.nearest([{ path: 'a.md' }], { threshold: 0 });

    expect(methods(link)).toEqual(['vault.attach', 'vault.attach', 'corpus.nearest']);
  });

  it('an attach answered after the epoch moved attaches nothing on the new connection', async () => {
    let answerStale: (value: unknown) => void = () => {};
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        calls += 1;
        if (calls > 1) return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
        return new Promise((resolve) => (answerStale = resolve));
      },
    });
    const backend = backendOver(services);

    // An attach on epoch 1 is still out when the connection is replaced …
    const stale = backend.status();
    await vi.waitFor(() => expect(link.request).toHaveBeenCalled());
    link.epoch = 2;
    // … the new connection attaches, and only then does the old answer arrive.
    expect(await backend.status()).toEqual({ state: 'ready' });
    answerStale({ vault: '/stale/key', profiles: { [PROFILE]: { state: 'ready' } } });
    await stale;
    await backend.nearest([{ path: 'a.md' }], { threshold: 0 });

    expect(methods(link)).toEqual(['vault.attach', 'vault.attach', 'corpus.nearest']);
    expect(link.request.mock.calls[2]?.[1]).toMatchObject({ vault: REAL });
  });

  it('status reads indexing 0/0 while the attach is in flight', async () => {
    let answer: (value: unknown) => void = () => {};
    const { services } = fakeServices({
      'vault.attach': () => new Promise((resolve) => (answer = resolve)),
    });
    const backend = backendOver(services);

    const first = backend.status();
    await vi.waitFor(() => expect(services.ensure).toHaveBeenCalled());
    await Promise.resolve();
    expect(await backend.status()).toEqual({ state: 'indexing', indexed: 0, total: 0 });

    answer({ vault: REAL, profiles: { [PROFILE]: { state: 'indexing', indexed: 1, total: 4 } } });
    // The caller that started the attach reads the status the attach answered.
    expect(await first).toEqual({ state: 'indexing', indexed: 1, total: 4 });
  });

  it('status reads indexing 0/0 at once while the first ensure locates the daemon', async () => {
    const { services, link } = fakeServices();
    services.mode = 'pending';
    const decide = holdEnsure(services);
    const backend = backendOver(services);

    expect(await settledSoon(backend.status())).toEqual(ATTACHING);
    expect(await settledSoon(backend.status())).toEqual(ATTACHING);
    // Both calls joined one ensure, and nothing reached the daemon yet.
    expect(services.ensure).toHaveBeenCalledTimes(1);
    expect(methods(link)).toEqual([]);

    decide('daemon');
    // The attach goes out once the daemon is reached, without another call.
    await vi.waitFor(() => expect(methods(link)).toEqual(['vault.attach']));
    expect(await backend.status()).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.status']);
  });

  it('a first ensure that goes local attaches the in-process backend in the background', async () => {
    const { services, link } = fakeServices();
    services.mode = 'pending';
    const decide = holdEnsure(services);
    const local = fakeLocal();
    const backend = backendOver(services, () => local);

    expect(await settledSoon(backend.status())).toEqual(ATTACHING);
    decide('local');
    await vi.waitFor(() => expect(local.status).toHaveBeenCalledTimes(1));
    expect(await backend.status()).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(methods(link)).toEqual([]);
  });

  it('once the switch is decided, status waits for a reconnect, then attaches', async () => {
    const { services, link } = fakeServices();
    const backend = backendOver(services);
    await backend.status();
    link.epoch = 2;
    const decide = holdEnsure(services);

    const status = backend.status();
    expect(await settledSoon(status)).toBe('still waiting');
    decide('daemon');
    expect(await status).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('status timeout reads unavailable', async () => {
    const { services, link } = fakeServices({
      'vault.status': () => {
        throw new DaemonTimeoutError('daemon request vault.status timed out after 10000 ms');
      },
    });
    const backend = backendOver(services);
    await backend.status(); // the attach

    expect(await backend.status()).toEqual({
      state: 'unavailable',
      reason: 'daemon did not answer',
    });
    // For that call only: the next one asks again.
    await backend.status();
    expect(methods(link).filter((m) => m === 'vault.status')).toHaveLength(2);
  });

  it('an attach timeout reads unavailable and the next call attaches again', async () => {
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        calls += 1;
        if (calls === 1) throw new DaemonTimeoutError('daemon request vault.attach timed out');
        return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
      },
    });
    const backend = backendOver(services);

    expect(await backend.status()).toEqual({
      state: 'unavailable',
      reason: 'daemon did not answer',
    });
    expect(await backend.status()).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('VAULT_UNAVAILABLE reads unavailable and re-attaches next call', async () => {
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        calls += 1;
        if (calls === 1) {
          throw new DaemonRpcError('VAULT_UNAVAILABLE', `vault "${VAULT}" is not a directory`);
        }
        return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
      },
    });
    const backend = backendOver(services);

    expect(await backend.status()).toEqual({
      state: 'unavailable',
      reason: `vault "${VAULT}" is not a directory`,
    });
    expect(await backend.status()).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('a dropped connection reads unavailable for that call', async () => {
    const { services } = fakeServices({
      'vault.attach': () => {
        throw new DaemonConnectionError('daemon connection closed during vault.attach');
      },
    });
    const backend = backendOver(services);

    expect(await backend.status()).toEqual({
      state: 'unavailable',
      reason: 'daemon connection closed during vault.attach',
    });
  });

  it('CORPUS_NOT_READY maps to the readiness error', async () => {
    const status = { state: 'indexing', indexed: 1, total: 3 };
    const { services } = fakeServices({
      'corpus.nearest': () => {
        throw new DaemonRpcError('CORPUS_NOT_READY', 'the corpus is indexing', { status });
      },
    });
    const backend = backendOver(services);

    const error = await backend.nearest([{ path: 'a.md' }], { threshold: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status).toEqual(status);
  });

  it('CORPUS_FAILED reaches the caller as a plain failure', async () => {
    const { services } = fakeServices({
      'corpus.nearestBlocks': () => {
        throw new DaemonRpcError('CORPUS_FAILED', 'disk on fire');
      },
    });
    const backend = backendOver(services);

    const error = await backend
      .nearestBlocks([{ path: 'a.md' }], { paths: ['a.md'], threshold: 0 })
      .catch((e) => e);
    expect(error).not.toBeInstanceOf(CorpusNotReadyError);
    expect((error as Error).message).toBe('disk on fire');
  });

  it('a NOT_ATTACHED read re-attaches on the next call', async () => {
    let reads = 0;
    const { services, link } = fakeServices({
      'corpus.nearest': (p) => {
        reads += 1;
        if (reads === 1) throw new DaemonRpcError('NOT_ATTACHED', 'not attached');
        return { hits: (p.anchors as unknown[]).map(() => []) };
      },
    });
    const backend = backendOver(services);

    await expect(backend.nearest([{ path: 'a.md' }], { threshold: 0 })).rejects.not.toBeInstanceOf(
      CorpusNotReadyError,
    );
    await backend.nearest([{ path: 'a.md' }], { threshold: 0 });

    expect(methods(link)).toEqual([
      'vault.attach',
      'corpus.nearest',
      'vault.attach',
      'corpus.nearest',
    ]);
  });

  it('reads send number[] anchors and no undefined keys', async () => {
    const { services, link } = fakeServices();
    const backend = backendOver(services);

    await backend.nearest([{ vector: Float32Array.from([0.5, 0.25]) }, { path: 'b.md' }], {
      threshold: 0.3,
      limit: undefined,
      allowed: ['a.md'],
    });
    await backend.nearestBlocks([{ vector: [1, 0] }], {
      paths: ['a.md'],
      threshold: 0.1,
      limit: 2,
    });

    const [, nearest, blocks] = link.request.mock.calls;
    expect(nearest?.[1]).toStrictEqual({
      vault: REAL,
      profile: PROFILE,
      anchors: [{ vector: [0.5, 0.25] }, { path: 'b.md' }],
      threshold: 0.3,
      allowed: ['a.md'],
    });
    expect(
      Array.isArray((nearest?.[1] as { anchors: { vector: unknown }[] }).anchors[0].vector),
    ).toBe(true);
    expect(blocks?.[1]).toStrictEqual({
      vault: REAL,
      profile: PROFILE,
      anchors: [{ vector: [1, 0] }],
      paths: ['a.md'],
      threshold: 0.1,
      limit: 2,
    });
  });

  it('switches to local once services is local', async () => {
    const { services, link } = fakeServices();
    const local = fakeLocal();
    const makeLocal = vi.fn(() => local);
    const backend = backendOver(services, makeLocal);
    await backend.status();

    services.mode = 'local';
    expect(await backend.status()).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(await backend.nearest([{ path: 'a.md' }], { threshold: 0 })).toEqual([
      [{ path: 'local.md', similarity: 1 }],
    ]);
    await backend.nearestBlocks([{ path: 'a.md' }], { paths: [], threshold: 0 });
    await backend.dispose();

    expect(makeLocal).toHaveBeenCalledTimes(1);
    expect(local.dispose).toHaveBeenCalledTimes(1);
    // Nothing after the switch went to the daemon.
    expect(methods(link)).toEqual(['vault.attach']);
  });

  it('disposing a backend that never went local builds nothing', async () => {
    const { services } = fakeServices();
    const makeLocal = vi.fn(fakeLocal);
    await backendOver(services, makeLocal).dispose();
    expect(makeLocal).not.toHaveBeenCalled();
  });

  it('sends no vault.attach once the services were closed under a connect', async () => {
    const written: string[] = [];
    const s = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, cb) => {
        written.push(chunk.toString());
        cb();
      },
    });
    let land: (value: Duplex) => void = () => {};
    const services = createSharedServices({
      shared: true,
      cliPath: '/opt/nv/dist/cli.js',
      version: '18.0.0',
      env: { XDG_CACHE_HOME: '/xdg' },
      home: '/home/u',
      uid: 501,
      platform: 'linux',
      build: () => ({ size: 10, mtimeMs: 20 }),
      stderr: { write: () => true },
      io: {
        ensureSocketDir: vi.fn(),
        connect: vi.fn(() => new Promise<Duplex>((resolve) => (land = resolve))),
        spawn: vi.fn(),
      },
    });
    const local = vi.fn(fakeLocal);
    const backend = backendOver(services, local);

    // The switch is undecided while the daemon is located: the status reads attaching.
    expect(await backend.status()).toEqual(ATTACHING);
    services.close();
    land(s);
    await vi.waitFor(() => expect(s.destroyed).toBe(true));
    // The background connect met the closed services: a later status says so.
    await vi.waitFor(async () =>
      expect(await backend.status()).toEqual({
        state: 'unavailable',
        reason: 'shared services closed: the session is shutting down',
      }),
    );

    await expect(backend.nearest([{ path: 'a.md' }], { threshold: 0 })).rejects.toBeInstanceOf(
      SharedServicesClosedError,
    );
    expect(written).toEqual([]);
    expect(s.destroyed).toBe(true);
    expect(local).not.toHaveBeenCalled();
  });
});
