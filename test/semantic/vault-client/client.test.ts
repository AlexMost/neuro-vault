import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { DaemonRpcError } from '../../../src/daemon/protocol.js';
import type { BackendStatus } from '../../../src/lib/obsidian/semantic-backend.js';
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
import {
  ATTACHING,
  createAttachment,
  createDaemonVaultClient,
  type IVaultAttachment,
  type IVaultClient,
} from '../../../src/modules/semantic/vault-client/index.js';

const VAULT = '/vaults/notes';
const REAL = '/private/vaults/notes';
const PROFILE = 'granite-97m';
const READ = { profile: PROFILE, anchors: [{ path: 'a.md' }], threshold: 0.5 };
const LEXICAL = { queries: ['alpha'], note_cap: 10, per_note_cap: 3 };

type Handler = (params: Record<string, unknown>) => unknown;

/** A connection answering per method; a handler may throw or return a promise. */
function fakeServices(handlers: Record<string, Handler> = {}) {
  const defaults: Record<string, Handler> = {
    'vault.attach': () => ({ vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } }),
    'vault.status': () => ({ state: 'ready' }),
    'corpus.nearest': (p) => ({ hits: (p.anchors as unknown[]).map(() => []) }),
    'corpus.nearestBlocks': (p) => ({ hits: (p.anchors as unknown[]).map(() => []) }),
    'lexical.search': () => ({
      notes: [],
      truncated: false,
      per_query_counts: {},
      per_query_token_counts: {},
      total_notes: 0,
    }),
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

/** A stand-in for the vault's in-process client. */
function fakeLocal() {
  return {
    call: vi.fn(async () => ({ hits: [[{ path: 'local.md', similarity: 1 }]] })),
    status: vi.fn(
      async (): Promise<BackendStatus> => ({ state: 'indexing', indexed: 2, total: 5 }),
    ),
    warm: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies IVaultClient;
}

function attachmentOver(services: ISharedServices): IVaultAttachment {
  return createAttachment({ link: services.connection, vaultRoot: VAULT, profiles: [PROFILE] });
}

function clientOver(
  services: ISharedServices,
  local: () => IVaultClient = fakeLocal,
  attachment: IVaultAttachment = attachmentOver(services),
): IVaultClient {
  return createDaemonVaultClient({ services, attachment, local });
}

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

describe('createDaemonVaultClient', () => {
  it('attaches once per epoch', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);

    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    await client.call('corpus.nearest', READ);

    expect(methods(link)).toEqual(['vault.attach', 'vault.status', 'corpus.nearest']);
    // Every call after the attach carries the realpath key the daemon answered with.
    expect(link.request.mock.calls[1]?.[1]).toEqual({ vault: REAL, profile: PROFILE });
    expect(link.request.mock.calls[2]?.[1]).toMatchObject({ vault: REAL, profile: PROFILE });
  });

  it('concurrent first calls share one attach', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);

    await Promise.all([
      client.call('corpus.nearest', READ),
      client.call('corpus.nearestBlocks', { ...READ, paths: ['a.md'] }),
      client.status(PROFILE),
    ]);

    expect(methods(link).filter((m) => m === 'vault.attach')).toHaveLength(1);
  });

  it('a first status after another reader attached reads the live status', async () => {
    const { services, link } = fakeServices({
      'vault.attach': () => ({
        vault: REAL,
        profiles: { [PROFILE]: { state: 'indexing', indexed: 0, total: 3 } },
      }),
      'vault.status': () => ({ state: 'ready' }),
    });
    const attachment = attachmentOver(services);
    const client = clientOver(services, fakeLocal, attachment);

    // The other reader attached at startup; the corpus has become ready since.
    await attachment.key();
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });

    expect(methods(link)).toEqual(['vault.attach', 'vault.status']);
  });

  it('an attach answered after the epoch moved attaches again and reads the new answer', async () => {
    let answerStale: (value: unknown) => void = () => {};
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        calls += 1;
        if (calls > 1)
          return {
            vault: REAL,
            profiles: { [PROFILE]: { state: 'indexing', indexed: 1, total: 2 } },
          };
        return new Promise((resolve) => (answerStale = resolve));
      },
    });
    const client = clientOver(services);

    const stale = client.status(PROFILE);
    await vi.waitFor(() => expect(link.request).toHaveBeenCalled());
    link.epoch = 2;
    answerStale({ vault: '/stale/key', profiles: { [PROFILE]: { state: 'ready' } } });

    expect(await stale).toEqual({ state: 'indexing', indexed: 1, total: 2 });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('re-attaches after a new epoch', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);
    await client.status(PROFILE);

    link.epoch = 2;
    await client.call('corpus.nearest', READ);

    expect(methods(link)).toEqual(['vault.attach', 'vault.attach', 'corpus.nearest']);
  });

  it('a call never carries a key from a replaced epoch', async () => {
    let answerStale: (value: unknown) => void = () => {};
    const keys = ['/stale/key', REAL, '/private/vaults/notes-moved'];
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        const vault = keys[calls++];
        const answer = { vault, profiles: { [PROFILE]: { state: 'ready' } } };
        return calls === 1
          ? new Promise((resolve) => (answerStale = () => resolve(answer)))
          : answer;
      },
    });
    const client = clientOver(services);

    // An attach on epoch 1 is still out when the connection is replaced …
    const stale = client.status(PROFILE);
    await vi.waitFor(() => expect(link.request).toHaveBeenCalled());
    link.epoch = 2;
    // … the new connection attaches, and only then does the old answer arrive: it records nothing.
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    answerStale(undefined);
    await stale;
    await client.call('corpus.nearest', READ);
    expect(link.request.mock.calls[2]?.[1]).toMatchObject({ vault: REAL });

    // Replaced between a status and a call: the call attaches on the new epoch first.
    link.epoch = 3;
    await client.call('corpus.nearest', READ);

    expect(methods(link)).toEqual([
      'vault.attach',
      'vault.attach',
      'corpus.nearest',
      'vault.attach',
      'corpus.nearest',
    ]);
    expect(link.request.mock.calls[4]?.[1]).toMatchObject({ vault: '/private/vaults/notes-moved' });
  });

  it('status reads indexing 0/0 while the attach is in flight', async () => {
    let answer: (value: unknown) => void = () => {};
    const { services } = fakeServices({
      'vault.attach': () => new Promise((resolve) => (answer = resolve)),
    });
    const client = clientOver(services);

    const first = client.status(PROFILE);
    await vi.waitFor(() => expect(services.ensure).toHaveBeenCalled());
    await Promise.resolve();
    expect(await client.status(PROFILE)).toEqual(ATTACHING);

    answer({ vault: REAL, profiles: { [PROFILE]: { state: 'indexing', indexed: 1, total: 4 } } });
    // The caller that started the attach reads the status the attach answered.
    expect(await first).toEqual({ state: 'indexing', indexed: 1, total: 4 });
  });

  it('status answers indexing 0/0 at once while ensure is pending', async () => {
    const { services, link } = fakeServices();
    services.mode = 'pending';
    const decide = holdEnsure(services);
    const client = clientOver(services);

    expect(await settledSoon(client.status(PROFILE))).toEqual(ATTACHING);
    expect(await settledSoon(client.status(PROFILE))).toEqual(ATTACHING);
    // Both calls joined one ensure, and nothing reached the daemon yet.
    expect(services.ensure).toHaveBeenCalledTimes(1);
    expect(methods(link)).toEqual([]);

    decide('daemon');
    // The attach goes out once the daemon is reached, without another call.
    await vi.waitFor(() => expect(methods(link)).toEqual(['vault.attach']));
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.status']);
  });

  it('a first ensure that goes local warms the in-process client in the background', async () => {
    const { services, link } = fakeServices();
    services.mode = 'pending';
    const decide = holdEnsure(services);
    const local = fakeLocal();
    const client = clientOver(services, () => local);

    expect(await settledSoon(client.status(PROFILE))).toEqual(ATTACHING);
    decide('local');
    await vi.waitFor(() => expect(local.warm).toHaveBeenCalledTimes(1));
    expect(await client.status(PROFILE)).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(local.status).toHaveBeenCalledWith(PROFILE);
    expect(methods(link)).toEqual([]);
  });

  it('once decided, status waits for a reconnect, then attaches', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);
    await client.status(PROFILE);
    link.epoch = 2;
    const decide = holdEnsure(services);

    const status = client.status(PROFILE);
    expect(await settledSoon(status)).toBe('still waiting');
    decide('daemon');
    expect(await status).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('a status timeout reads unavailable "daemon did not answer"', async () => {
    const { services, link } = fakeServices({
      'vault.status': () => {
        throw new DaemonTimeoutError('daemon request vault.status timed out after 10000 ms');
      },
    });
    const client = clientOver(services);
    await client.status(PROFILE); // the attach

    expect(await client.status(PROFILE)).toEqual({
      state: 'unavailable',
      reason: 'daemon did not answer',
    });
    // For that call only: the next one asks again.
    await client.status(PROFILE);
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
    const client = clientOver(services);

    expect(await client.status(PROFILE)).toEqual({
      state: 'unavailable',
      reason: 'daemon did not answer',
    });
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
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
    const client = clientOver(services);

    expect(await client.status(PROFILE)).toEqual({
      state: 'unavailable',
      reason: `vault "${VAULT}" is not a directory`,
    });
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('a dropped connection reads unavailable for that call', async () => {
    let calls = 0;
    const { services, link } = fakeServices({
      'vault.attach': () => {
        calls += 1;
        if (calls === 1) {
          throw new DaemonConnectionError('daemon connection closed during vault.attach');
        }
        return { vault: REAL, profiles: { [PROFILE]: { state: 'ready' } } };
      },
    });
    const client = clientOver(services);

    expect(await client.status(PROFILE)).toEqual({
      state: 'unavailable',
      reason: 'daemon connection closed during vault.attach',
    });
    // Never a lasting state, and never the switch: the next call goes to the daemon again.
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });
    expect(services.mode).toBe('daemon');
    expect(methods(link)).toEqual(['vault.attach', 'vault.attach']);
  });

  it('NOT_ATTACHED on a call forgets the attach', async () => {
    let reads = 0;
    const { services, link } = fakeServices({
      'corpus.nearest': (p) => {
        reads += 1;
        if (reads === 1) throw new DaemonRpcError('NOT_ATTACHED', 'not attached');
        return { hits: (p.anchors as unknown[]).map(() => []) };
      },
    });
    const client = clientOver(services);

    // It rejects as itself: mapping it is the views' work.
    await expect(client.call('corpus.nearest', READ)).rejects.toMatchObject({
      name: 'DaemonRpcError',
      code: 'NOT_ATTACHED',
    });
    await client.call('corpus.nearest', READ);

    expect(methods(link)).toEqual([
      'vault.attach',
      'corpus.nearest',
      'vault.attach',
      'corpus.nearest',
    ]);
  });

  it('NOT_ATTACHED on vault.status forgets the attach', async () => {
    let statuses = 0;
    const { services, link } = fakeServices({
      'vault.status': () => {
        statuses += 1;
        if (statuses === 1) throw new DaemonRpcError('NOT_ATTACHED', 'not attached');
        return { state: 'ready' };
      },
    });
    const client = clientOver(services);
    await client.status(PROFILE); // the attach

    expect(await client.status(PROFILE)).toEqual({ state: 'unavailable', reason: 'not attached' });
    // The next status attaches again and reads that answer.
    expect(await client.status(PROFILE)).toEqual({ state: 'ready' });

    expect(methods(link)).toEqual(['vault.attach', 'vault.status', 'vault.attach']);
  });

  it('any other refused call rejects as the daemon error, and keeps the attach', async () => {
    const status = { state: 'indexing', indexed: 1, total: 3 };
    const { services, link } = fakeServices({
      'corpus.nearest': () => {
        throw new DaemonRpcError('CORPUS_NOT_READY', 'the corpus is indexing', { status });
      },
      'corpus.nearestBlocks': () => {
        throw new DaemonRpcError('CORPUS_FAILED', 'disk on fire');
      },
    });
    const client = clientOver(services);

    const notReady = await client.call('corpus.nearest', READ).catch((e: unknown) => e);
    expect(notReady).toBeInstanceOf(DaemonRpcError);
    expect(notReady).toMatchObject({ code: 'CORPUS_NOT_READY', data: { status } });
    await expect(
      client.call('corpus.nearestBlocks', { ...READ, paths: ['a.md'] }),
    ).rejects.toMatchObject({ code: 'CORPUS_FAILED', message: 'disk on fire' });

    expect(methods(link)).toEqual(['vault.attach', 'corpus.nearest', 'corpus.nearestBlocks']);
  });

  it('calls carry the vault key and the per-method timeout', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);

    await client.status(PROFILE);
    await client.status(PROFILE);
    await client.call('corpus.nearest', READ);
    await client.call('lexical.search', LEXICAL);

    expect(link.request.mock.calls).toEqual([
      ['vault.attach', { vault: VAULT, profiles: [PROFILE] }, 10_000],
      ['vault.status', { vault: REAL, profile: PROFILE }, 10_000],
      ['corpus.nearest', { ...READ, vault: REAL }, 30_000],
      ['lexical.search', { ...LEXICAL, vault: REAL }, 30_000],
    ]);
  });

  it('a call that times out or loses the connection rejects as itself, and never flips the switch', async () => {
    const failures = [
      new DaemonTimeoutError('daemon request lexical.search timed out after 30000 ms'),
      new DaemonConnectionError('daemon connection closed during lexical.search'),
    ];
    let reads = 0;
    const { services, link } = fakeServices({
      'lexical.search': () => {
        const failure = failures[reads++];
        if (failure) throw failure;
        return { notes: [], truncated: false };
      },
    });
    const client = clientOver(services);

    for (const failure of failures) {
      await expect(client.call('lexical.search', LEXICAL)).rejects.toBe(failure);
      expect(services.mode).toBe('daemon');
    }
    // The next call goes to the daemon again, on the attach it kept.
    await expect(client.call('lexical.search', LEXICAL)).resolves.toMatchObject({ notes: [] });
    expect(methods(link)).toEqual([
      'vault.attach',
      'lexical.search',
      'lexical.search',
      'lexical.search',
    ]);
  });

  it('every call goes to the local client once the switch is local; it is built once', async () => {
    const { services, link } = fakeServices();
    const local = fakeLocal();
    const makeLocal = vi.fn(() => local);
    const client = clientOver(services, makeLocal);
    await client.status(PROFILE);

    services.mode = 'local';
    expect(await client.status(PROFILE)).toEqual({ state: 'indexing', indexed: 2, total: 5 });
    expect(await client.call('corpus.nearest', READ)).toEqual({
      hits: [[{ path: 'local.md', similarity: 1 }]],
    });
    await client.call('corpus.nearestBlocks', { ...READ, paths: [] });
    await client.call('lexical.search', LEXICAL);
    await client.warm();

    expect(makeLocal).toHaveBeenCalledTimes(1);
    expect(local.call).toHaveBeenCalledWith('corpus.nearest', READ);
    expect(local.call).toHaveBeenCalledWith('lexical.search', LEXICAL);
    expect(local.warm).toHaveBeenCalledTimes(1);
    // Nothing after the switch went to the daemon.
    expect(methods(link)).toEqual(['vault.attach']);
  });

  it('dispose disposes only a local client that was built', async () => {
    const never = fakeServices();
    const unbuilt = vi.fn(fakeLocal);
    await clientOver(never.services, unbuilt).dispose();
    expect(unbuilt).not.toHaveBeenCalled();

    const { services } = fakeServices();
    services.mode = 'local';
    const local = fakeLocal();
    const client = clientOver(services, () => local);
    await client.status(PROFILE);
    await client.dispose();
    expect(local.dispose).toHaveBeenCalledTimes(1);
  });

  it('sends no vault.attach once the services closed under a connect; a later status reads unavailable', async () => {
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
    const client = clientOver(services, local);

    // The switch is undecided while the daemon is located: the status reads attaching.
    expect(await client.status(PROFILE)).toEqual(ATTACHING);
    services.close();
    land(s);
    await vi.waitFor(() => expect(s.destroyed).toBe(true));
    // The background connect met the closed services: a later status says so.
    await vi.waitFor(async () =>
      expect(await client.status(PROFILE)).toEqual({
        state: 'unavailable',
        reason: 'shared services closed: the session is shutting down',
      }),
    );

    await expect(client.call('corpus.nearest', READ)).rejects.toBeInstanceOf(
      SharedServicesClosedError,
    );
    expect(written).toEqual([]);
    expect(s.destroyed).toBe(true);
    expect(local).not.toHaveBeenCalled();
  });

  it('warm attaches and never rejects', async () => {
    const { services, link } = fakeServices();
    const client = clientOver(services);
    await expect(client.warm()).resolves.toBeUndefined();
    expect(methods(link)).toEqual(['vault.attach']);

    const refused = fakeServices({
      'vault.attach': () => {
        throw new DaemonRpcError('VAULT_UNAVAILABLE', 'gone');
      },
    });
    await expect(clientOver(refused.services).warm()).resolves.toBeUndefined();

    const closed = fakeServices();
    closed.services.ensure.mockRejectedValue(new SharedServicesClosedError());
    await expect(clientOver(closed.services).warm()).resolves.toBeUndefined();
    // A rejected ensure reads unavailable on status too, never a rejection.
    expect(await clientOver(closed.services).status(PROFILE)).toEqual({
      state: 'unavailable',
      reason: 'shared services closed: the session is shutting down',
    });
  });
});
