import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { MODEL_PROFILES } from '../../../src/lib/model-profiles.js';
import { CorpusNotReadyError } from '../../../src/lib/obsidian/semantic-backend.js';
import {
  createVaultEntry,
  VaultEntries,
  type IVaultEntriesDeps,
} from '../../../src/lib/vault-entry/index.js';
import type { IDaemonLink } from '../../../src/modules/semantic/daemon-connection.js';
import type { QueuedEmbedder } from '../../../src/modules/semantic/embed-queue.js';
import type { ISharedServices } from '../../../src/modules/semantic/shared-services.js';
import { createVaultClients } from '../../../src/modules/semantic/vault-client/index.js';

const PROFILE = 'granite-97m';

function fakeServices(mode: ISharedServices['mode'] = 'daemon') {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'vault.attach') {
      return { vault: params.vault, profiles: { [PROFILE]: { state: 'ready' } } };
    }
    return { state: 'ready' };
  });
  const services = {
    mode,
    connection: { epoch: 1, ensure: async () => {}, close: () => {}, request } as IDaemonLink,
    ensure: vi.fn(async () =>
      services.mode === 'local' ? ('local' as const) : ('daemon' as const),
    ),
    close: vi.fn(),
  };
  return { services, request };
}

/** Records the deps the entries were built with; attaches answer `ready`. */
function fakeEntries() {
  const built: IVaultEntriesDeps[] = [];
  const entries = {
    attach: vi.fn(async (_id: number, vault: string, profiles: readonly string[]) => ({
      vault,
      profiles: Object.fromEntries(profiles.map((p) => [p, { state: 'ready' as const }])),
    })),
    status: vi.fn(() => ({ state: 'ready' as const })),
    reader: vi.fn(() => ({
      reader: { nearest: async () => [[]], nearestBlocks: async () => [[]] },
      status: { state: 'ready' as const },
      dims: 384,
    })),
    detach: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
  const createEntries = vi.fn((deps: IVaultEntriesDeps) => {
    built.push(deps);
    return entries as unknown as VaultEntries;
  });
  return { entries, createEntries, built };
}

/** The client id every in-process attach went out under: the one loopback's. */
function loopbackIdOf(entries: ReturnType<typeof fakeEntries>['entries']): number {
  const ids = new Set(entries.attach.mock.calls.map(([id]) => id));
  expect(ids.size).toBe(1);
  return [...ids][0];
}

const embedFn = vi.fn(async (texts: string[]) => texts.map(() => [1]));
const embedder = { asDocumentEmbedFn: () => embedFn } as unknown as QueuedEmbedder;

describe('createVaultClients', () => {
  it('--no-shared serves every vault from one in-process VaultEntries', async () => {
    const { services, request } = fakeServices('local');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });

    const a = clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true });
    const b = clients.semanticBackendFactory({ vaultRoot: '/v/b', vaultName: 'b', enabled: true });
    expect(await a.status()).toEqual({ state: 'ready' });
    expect(await b.status()).toEqual({ state: 'ready' });

    expect(createEntries).toHaveBeenCalledTimes(1);
    const id = loopbackIdOf(entries);
    expect(entries.attach).toHaveBeenCalledWith(id, '/v/a', [PROFILE]);
    expect(entries.attach).toHaveBeenCalledWith(id, '/v/b', [PROFILE]);
    expect(request).not.toHaveBeenCalled();
  });

  it('--shared reaches the daemon and builds no entries while it answers', async () => {
    const { services, request } = fakeServices('daemon');
    const { createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: true,
      profile: PROFILE,
      embedder,
      createEntries,
    });

    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    expect(await backend.status()).toEqual({ state: 'ready' });

    expect(request).toHaveBeenCalledWith(
      'vault.attach',
      { vault: '/v/a', profiles: [PROFILE] },
      10_000,
    );
    expect(createEntries).not.toHaveBeenCalled();
    await clients.dispose();
  });

  it('--shared builds the entries once, on the first call after the switch went local', async () => {
    const { services } = fakeServices('daemon');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: true,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    const a = clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true });
    const b = clients.semanticBackendFactory({ vaultRoot: '/v/b', vaultName: 'b', enabled: true });

    services.mode = 'local';
    await a.status();
    await b.nearest([{ path: 'x.md' }], { threshold: 0 });

    expect(createEntries).toHaveBeenCalledTimes(1);
    expect(entries.attach).toHaveBeenCalledTimes(2);
  });

  it('the entries embed with the session embedder, for its profile only, and never idle out', () => {
    const { services } = fakeServices('local');
    const { createEntries, built } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true });

    const [deps] = built;
    expect(deps.idleTimeoutMs).toBe(0);
    expect(deps.embedderFor(PROFILE)).toBe(embedFn);
    expect(() => deps.embedderFor('harrier-270m')).toThrow(/granite-97m/);
  });

  it("a disabled vault's semantic backend never attaches by itself", async () => {
    for (const shared of [true, false]) {
      const { services, request } = fakeServices(shared ? 'daemon' : 'local');
      const { createEntries } = fakeEntries();
      const clients = createVaultClients({
        services,
        shared,
        profile: PROFILE,
        embedder,
        createEntries,
      });

      const backend = clients.semanticBackendFactory({
        vaultRoot: '/v/a',
        vaultName: 'a',
        enabled: false,
      });
      expect(await backend.status()).toEqual({ state: 'disabled' });
      const error = await backend
        .nearest([{ path: 'x.md' }], { threshold: 0 })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CorpusNotReadyError);
      expect((error as CorpusNotReadyError).status).toEqual({ state: 'disabled' });
      await expect(
        backend.nearestBlocks([{ path: 'x.md' }], { paths: [], threshold: 0 }),
      ).rejects.toBeInstanceOf(CorpusNotReadyError);

      expect(createEntries).not.toHaveBeenCalled();
      expect(services.ensure).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('dispose disposes the entries, and only once they exist', async () => {
    const build = () => {
      const { services } = fakeServices('local');
      const fake = fakeEntries();
      const clients = createVaultClients({
        services,
        shared: false,
        profile: PROFILE,
        embedder,
        createEntries: fake.createEntries,
      });
      return { clients, ...fake };
    };

    const unused = build();
    await unused.clients.dispose();
    expect(unused.createEntries).not.toHaveBeenCalled();

    const used = build();
    used.clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true });
    await used.clients.dispose();
    expect(used.entries.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose closes the in-process link before disposing the entries', async () => {
    const { services } = fakeServices('local');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    // The attach over the loopback hooks its close, as the daemon hooks a connection's.
    expect(await backend.status()).toEqual({ state: 'ready' });
    expect(entries.detach).not.toHaveBeenCalled();

    await clients.dispose();

    expect(entries.detach).toHaveBeenCalledExactlyOnceWith(loopbackIdOf(entries));
    expect(entries.dispose).toHaveBeenCalledTimes(1);
    expect(entries.detach.mock.invocationCallOrder[0]).toBeLessThan(
      entries.dispose.mock.invocationCallOrder[0],
    );
  });

  it('dispose still disposes the entries when closing the link throws', async () => {
    const { services } = fakeServices('local');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    expect(await backend.status()).toEqual({ state: 'ready' });
    entries.detach.mockImplementation(() => {
      throw new Error('detach failed');
    });

    await clients.dispose().catch(() => {});

    expect(entries.detach).toHaveBeenCalledTimes(1);
    expect(entries.dispose).toHaveBeenCalledTimes(1);
  });

  it('after dispose, a root already built under --no-shared is refused like any other', async () => {
    const { services } = fakeServices('local');
    const { createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true });
    await clients.dispose();

    expect(() =>
      clients.semanticBackendFactory({ vaultRoot: '/v/a', vaultName: 'a', enabled: true }),
    ).toThrow(/vault clients disposed/);
  });

  it('a switch to local that lands after dispose builds no entries', async () => {
    const { services } = fakeServices('daemon');
    let flip: (mode: 'local') => void = () => {};
    services.ensure.mockImplementation(() => new Promise((resolve) => (flip = resolve)));
    const { createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: true,
      profile: PROFILE,
      embedder,
      createEntries,
    });
    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });

    // The startup status read, still waiting on the daemon when the client hangs up.
    const status = backend.status();
    await clients.dispose();
    flip('local');

    expect(await status).toMatchObject({ state: 'unavailable' });
    expect(createEntries).not.toHaveBeenCalled();
  });

  /** The registry's lexical factory call for `root`; the clients ignore the reader and graph. */
  const lexicalFor = (
    clients: ReturnType<typeof createVaultClients>,
    root: string,
    enabled = true,
  ) =>
    clients.lexicalReaderFactory({
      vaultRoot: root,
      vaultName: root.slice(-1),
      reader: {} as never,
      graph: {} as never,
      enabled,
    });

  it('the semantic backend and the lexical reader of a vault share one attach', async () => {
    const { services, request } = fakeServices('daemon');
    const { createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: true,
      profile: PROFILE,
      embedder,
      createEntries,
    });

    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    const reader = lexicalFor(clients, '/v/a');
    await Promise.all([backend.status(), reader.warm()]);
    await reader.warm();
    await backend.status();

    const attaches = request.mock.calls.filter(([method]) => method === 'vault.attach');
    expect(attaches).toEqual([['vault.attach', { vault: '/v/a', profiles: [PROFILE] }, 10_000]]);
    expect(createEntries).not.toHaveBeenCalled();
  });

  it('--no-shared: the backend and the reader of a vault share one in-process attach', async () => {
    const { services, request } = fakeServices('local');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: false,
      profile: PROFILE,
      embedder,
      createEntries,
    });

    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    const reader = lexicalFor(clients, '/v/a');
    await Promise.all([backend.status(), reader.warm()]);
    await reader.warm();

    expect(createEntries).toHaveBeenCalledTimes(1);
    expect(entries.attach).toHaveBeenCalledTimes(1);
    expect(entries.attach).toHaveBeenCalledWith(expect.any(Number), '/v/a', [PROFILE]);
    expect(services.ensure).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('an opted-out vault attaches for its lexical leg with no profiles', async () => {
    for (const shared of [true, false]) {
      const { services, request } = fakeServices(shared ? 'daemon' : 'local');
      const { entries, createEntries } = fakeEntries();
      const clients = createVaultClients({
        services,
        shared,
        profile: PROFILE,
        embedder,
        createEntries,
      });

      const backend = clients.semanticBackendFactory({
        vaultRoot: '/v/off',
        vaultName: 'off',
        enabled: false,
      });
      await lexicalFor(clients, '/v/off', false).warm();

      expect(await backend.status()).toEqual({ state: 'disabled' });
      if (shared) {
        expect(request).toHaveBeenCalledWith(
          'vault.attach',
          { vault: '/v/off', profiles: [] },
          10_000,
        );
        expect(createEntries).not.toHaveBeenCalled();
      } else {
        expect(entries.attach).toHaveBeenCalledWith(expect.any(Number), '/v/off', []);
        expect(request).not.toHaveBeenCalled();
      }
    }
  });

  it('--shared: once the switch went local, the reader attaches the in-process entry', async () => {
    const { services, request } = fakeServices('local');
    const { entries, createEntries } = fakeEntries();
    const clients = createVaultClients({
      services,
      shared: true,
      profile: PROFILE,
      embedder,
      createEntries,
    });

    const backend = clients.semanticBackendFactory({
      vaultRoot: '/v/a',
      vaultName: 'a',
      enabled: true,
    });
    const reader = lexicalFor(clients, '/v/a');
    await reader.warm();
    await backend.status();

    expect(createEntries).toHaveBeenCalledTimes(1);
    // The backend and the reader share the vault's one in-process client, so one attach.
    expect(entries.attach).toHaveBeenCalledTimes(1);
    expect(entries.attach).toHaveBeenCalledWith(expect.any(Number), '/v/a', [PROFILE]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('createVaultClients --no-shared over real vault entries', () => {
  /** A note long enough to be embedded (`MIN_CHARS`), distinct per `seed`. */
  const noteBody = (seed: string) =>
    `# ${seed}\n\n${`${seed} is a note that talks about one thing in some detail. `.repeat(8)}\n`;

  it(
    'both views of a vault read through the loopback, with Float32Array anchors',
    { timeout: 15_000 },
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-vault-clients-'));
      const dims = MODEL_PROFILES[PROFILE].dims;
      // alpha and beta point one way, gamma the other; no model loads.
      const embed = async (texts: string[]) =>
        texts.map((text) => {
          const v = new Array<number>(dims).fill(0);
          v[text.includes('gamma') ? 1 : 0] = 1;
          return v;
        });
      const { services, request } = fakeServices('local');
      const clients = createVaultClients({
        services,
        shared: false,
        profile: PROFILE,
        embedder: { asDocumentEmbedFn: () => embed } as unknown as QueuedEmbedder,
        createEntries: (deps) =>
          new VaultEntries({
            ...deps,
            createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: 100 }),
            warn: () => {},
          }),
      });
      try {
        for (const seed of ['alpha', 'beta', 'gamma']) {
          await fs.writeFile(path.join(root, `${seed}.md`), noteBody(seed));
        }
        const backend = clients.semanticBackendFactory({
          vaultRoot: root,
          vaultName: 'v',
          enabled: true,
        });
        const lexical = clients.lexicalReaderFactory({
          vaultRoot: root,
          vaultName: 'v',
          reader: {} as never,
          graph: {} as never,
          enabled: true,
        });
        await vi.waitFor(async () => expect(await backend.status()).toEqual({ state: 'ready' }), {
          timeout: 10_000,
          interval: 20,
        });

        const anchor = new Float32Array(dims);
        anchor[0] = 1;
        const [hits] = await backend.nearest([{ vector: anchor }], { threshold: 0.5 });
        expect(hits?.map((hit) => hit.path).sort()).toEqual(['alpha.md', 'beta.md']);
        const found = await lexical.search({ queries: ['gamma'], noteCap: 10, perNoteCap: 3 });
        expect(found.notes.map((note) => note.path)).toContain('gamma.md');
        expect(request).not.toHaveBeenCalled();
      } finally {
        await clients.dispose();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
