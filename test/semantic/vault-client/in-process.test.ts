import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { isJSONRPCResultResponse } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonRpcError,
  ServiceRegistry,
  type VaultAttachResult,
} from '../../../src/daemon/protocol.js';
import { createVaultEntryServices } from '../../../src/daemon/services/vault-entry-services.js';
import { MODEL_PROFILES } from '../../../src/lib/model-profiles.js';
import type { BackendStatus } from '../../../src/lib/obsidian/semantic-backend.js';
import { createVaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import {
  createVaultEntry,
  VaultEntries,
  type IVaultEntriesDeps,
} from '../../../src/lib/vault-entry/index.js';
import {
  ATTACHING,
  createAttachment,
  createInProcessLink,
  createLinkedVaultClient,
  type IInProcessLink,
  type IVaultClient,
} from '../../../src/modules/semantic/vault-client/index.js';
import { testCtx } from '../../daemon/_ctx.js';

const PROFILE = 'granite-97m';
const CLIENT_ID = 0;

/** A note long enough to be embedded (`MIN_CHARS`), distinct per `seed`. */
const noteBody = (seed: string) =>
  `# ${seed}\n\n${`${seed} is a note that talks about one thing in some detail. `.repeat(8)}\n`;

describe('createLinkedVaultClient over the in-process loopback', () => {
  let root: string;
  let vault: string;
  let entries: VaultEntries | undefined;
  /** While set, the fake embedder waits for it: a pass cannot finish, so the corpus stays `indexing`. */
  let embedGate: Promise<void> | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-vault-client-'));
    vault = path.join(root, 'vault');
    await fs.mkdir(vault);
    await fs.writeFile(path.join(vault, 'alpha.md'), noteBody('alpha'));
    await fs.writeFile(path.join(vault, 'beta.md'), noteBody('beta'));
    await fs.writeFile(path.join(vault, 'gamma.md'), noteBody('gamma'));
    embedGate = undefined;
  });

  afterEach(async () => {
    await entries?.dispose();
    entries = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeEntries(extra: Partial<IVaultEntriesDeps> = {}): VaultEntries {
    entries = new VaultEntries({
      // Vectors of the profile's own width, so the real ShardStore accepts them; no model loads.
      // alpha and beta point one way, gamma the other.
      embedderFor: (key) => async (texts) => {
        await embedGate;
        return texts.map((text) => {
          const v = new Array<number>(MODEL_PROFILES[key].dims).fill(0);
          v[text.includes('gamma') ? 1 : 0] = 1;
          return v;
        });
      },
      idleTimeoutMs: 0,
      createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: 100 }),
      warn: () => {},
      ...extra,
    });
    return entries;
  }

  /** The in-process client of `vaultRoot`, as the session builds it, and its link. */
  function clientOver(
    all: VaultEntries,
    vaultRoot: string,
  ): { client: IVaultClient; link: IInProcessLink } {
    const link = createInProcessLink(createVaultEntryServices(all), { clientId: CLIENT_ID });
    const attachment = createAttachment({ link, vaultRoot, profiles: [PROFILE] });
    return { client: createLinkedVaultClient({ link, attachment }), link };
  }

  async function untilReady(read: () => Promise<BackendStatus>): Promise<void> {
    await vi.waitFor(async () => expect(await read()).toEqual({ state: 'ready' }), {
      timeout: 5_000,
      interval: 20,
    });
  }

  it('status reads indexing 0/0 while the first attach is in flight, then the entry status', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const all = makeEntries({
      loadScope: async () => {
        await gate;
        return { scope: createVaultScope({}), semantic: true };
      },
    });
    const attach = vi.spyOn(all, 'attach');
    const { client } = clientOver(all, vault);

    const first = client.status(PROFILE);
    expect(await client.status(PROFILE)).toEqual(ATTACHING);
    release();
    expect((await first).state).toMatch(/^(indexing|ready)$/);
    await untilReady(() => client.status(PROFILE));
    await client.call('corpus.nearest', {
      profile: PROFILE,
      anchors: [{ path: 'alpha.md' }],
      threshold: 0,
    });

    // The statuses and the read after ready all ran on the one attach.
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(CLIENT_ID, vault, [PROFILE]);
  });

  it('reads answer once the profile is ready', async () => {
    const { client } = clientOver(makeEntries(), vault);
    await untilReady(() => client.status(PROFILE));

    const { hits } = await client.call('corpus.nearest', {
      profile: PROFILE,
      anchors: [{ path: 'alpha.md' }],
      threshold: 0.5,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.map((hit) => hit.path).sort()).toEqual(['alpha.md', 'beta.md']);
  });

  it('with the embed held, the first status reads the attach answer for the profile', async () => {
    embedGate = new Promise(() => {});
    const all = makeEntries();
    const attach = vi.spyOn(all, 'attach');
    const { client } = clientOver(all, vault);

    const first = await client.status(PROFILE);

    const answered = await (attach.mock.results[0]?.value as ReturnType<VaultEntries['attach']>);
    expect(answered.profiles[PROFILE]).toMatchObject({ state: 'indexing' });
    expect(first).toEqual(answered.profiles[PROFILE]);
  });

  it('serves nearest with exclude and nearestBlocks once ready', async () => {
    const { client } = clientOver(makeEntries(), vault);
    await untilReady(() => client.status(PROFILE));

    const { hits } = await client.call('corpus.nearest', {
      profile: PROFILE,
      anchors: [{ path: 'alpha.md' }],
      threshold: -1,
      exclude: ['alpha.md'],
    });
    expect(hits[0]).toEqual([
      { path: 'beta.md', similarity: 1 },
      { path: 'gamma.md', similarity: 0 },
    ]);
    const blocks = await client.call('corpus.nearestBlocks', {
      profile: PROFILE,
      anchors: [{ path: 'alpha.md' }],
      paths: ['alpha.md'],
      threshold: 0.5,
    });
    expect(blocks.hits).toHaveLength(1);
    expect(blocks.hits[0]?.every((hit) => hit.path === 'alpha.md')).toBe(true);
  });

  it('a read while indexing is refused CORPUS_NOT_READY with the status in data', async () => {
    embedGate = new Promise(() => {});
    const { client } = clientOver(makeEntries(), vault);
    expect((await client.status(PROFILE)).state).toBe('indexing');

    const error = await client
      .call('corpus.nearest', { profile: PROFILE, anchors: [{ path: 'alpha.md' }], threshold: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as DaemonRpcError).code).toBe('CORPUS_NOT_READY');
    expect((error as DaemonRpcError).data?.status).toMatchObject({ state: 'indexing' });
  });

  it('a vault that cannot be attached reads unavailable and refuses calls with VAULT_UNAVAILABLE', async () => {
    const { client } = clientOver(makeEntries(), path.join(root, 'missing'));

    const status = await client.status(PROFILE);
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('cannot resolve vault');
    const error = await client
      .call('corpus.nearest', { profile: PROFILE, anchors: [{ path: 'alpha.md' }], threshold: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DaemonRpcError);
    expect((error as DaemonRpcError).code).toBe('VAULT_UNAVAILABLE');
  });

  it('closing the link detaches it from the entry', async () => {
    const all = makeEntries();
    const { client, link } = clientOver(all, vault);
    await client.warm();
    expect(all.info()[0]?.clients).toBe(1);

    link.close();
    expect(all.info()[0]?.clients).toBe(0);
  });

  it('the same read answers the same in-process and through the daemon service registry', async () => {
    const all = makeEntries();
    const { client } = clientOver(all, vault);
    await untilReady(() => client.status(PROFILE));
    const read = {
      profile: PROFILE,
      anchors: [{ path: 'alpha.md' }, { path: 'gamma.md' }],
      threshold: -1,
    };
    const inProcess = await client.call('corpus.nearest', read);

    // What the daemon would answer another connection that attached the same vault.
    const registry = new ServiceRegistry();
    for (const [name, handlers] of Object.entries(createVaultEntryServices(all))) {
      registry.register(name, handlers);
    }
    const ctx = testCtx(7);
    let id = 0;
    async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
      const request: JSONRPCRequest = { jsonrpc: '2.0', id: ++id, method, params };
      const response = await registry.dispatch(request, ctx);
      if (!isJSONRPCResultResponse(response)) throw new Error(JSON.stringify(response));
      return response.result;
    }
    const attached = (await dispatch('vault.attach', {
      vault,
      profiles: [PROFILE],
    })) as VaultAttachResult;
    const overSocket = await dispatch('corpus.nearest', { ...read, vault: attached.vault });

    expect(overSocket).toEqual(inProcess);
    expect(all.info()[0]?.clients).toBe(2);
  });
});
