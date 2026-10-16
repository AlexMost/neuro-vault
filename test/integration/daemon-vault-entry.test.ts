import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServiceRegistry, type DaemonInfoResult } from '../../src/daemon/protocol.js';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import { createVaultService } from '../../src/daemon/services/vault.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import { MODEL_PROFILES } from '../../src/lib/model-profiles.js';
import { VaultEntries } from '../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../src/lib/vault-entry/vault-entry.js';

const PROFILE = 'granite-97m';
const OTHER_PROFILE = 'harrier-270m';
const DEBOUNCE_MS = 100;
/** chokidar's `awaitWriteFinish` stability threshold (watcher.ts): a write is reported this late at best. */
const WRITE_FINISH_MS = 2_000;
/** chokidar's `awaitWriteFinish` poll interval (watcher.ts). */
const WRITE_POLL_MS = 200;
/** What a pass over this three-note vault is allowed to take on a slow runner. */
const PASS_BUDGET_MS = 3_000;
const posix = process.platform !== 'win32';

/** The `LineClient` of test/daemon/socket-server.test.ts, with request/response correlation on top. */
class LineClient {
  private readonly buffer = new ReadBuffer();
  private readonly waiting = new Map<
    number,
    { resolve: (m: JSONRPCMessage) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private ended: Error | undefined;
  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.readMessage();
        if (!message) break;
        const id = (message as { id?: number }).id;
        if (id === undefined) continue;
        const pending = this.waiting.get(id);
        this.waiting.delete(id);
        pending?.resolve(message);
      }
    });
    // A dropped connection fails what is waiting, rather than hanging until the test times out.
    const end = (error: Error) => {
      this.ended ??= error;
      for (const pending of this.waiting.values()) pending.reject(this.ended);
      this.waiting.clear();
    };
    socket.on('error', (err) => end(new Error(`socket error: ${err.message}`)));
    socket.on('close', () => end(new Error('socket closed before the response arrived')));
  }
  static connect(p: string): Promise<LineClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(p);
      socket.once('connect', () => resolve(new LineClient(socket)));
      socket.once('error', reject);
    });
  }
  call(method: string, params?: Record<string, unknown>): Promise<JSONRPCMessage> {
    const id = this.nextId++;
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.write(serializeMessage({ jsonrpc: '2.0', id, method, params }));
    });
  }
  /** The `result` of a call that must succeed. */
  async result<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.call(method, params);
    if (!('result' in response)) throw new Error(`${method} failed: ${JSON.stringify(response)}`);
    return response.result as T;
  }
  /** The wire `data.code` of a call that must fail. */
  async errorCode(method: string, params?: Record<string, unknown>): Promise<string> {
    const response = await this.call(method, params);
    if (!('error' in response)) throw new Error(`${method} succeeded: ${JSON.stringify(response)}`);
    return (response.error.data as { code: string }).code;
  }
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) return resolve();
      this.socket.once('close', () => resolve());
      this.socket.destroy();
    });
  }
}

type Status = { state: string; indexed?: number; total?: number; reason?: string };
interface Attached {
  vault: string;
  profiles: Record<string, Status>;
}

/** A note long enough to be embedded (`MIN_CHARS`), distinct per `seed`. */
const noteBody = (seed: string) =>
  `# ${seed}\n\n${`${seed} is a note that talks about one thing in some detail. `.repeat(8)}\n`;

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`condition not met in ${timeoutMs} ms; last: ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!posix)('vault entry over a real socket', () => {
  let dir: string;
  let socketPath: string;
  let handle: DaemonServerHandle | undefined;
  let entries: VaultEntries | undefined;
  let clients: LineClient[];
  /** Per profile key: how many documents the fake embedder was asked to embed. */
  let embedded: Map<string, number>;

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-ve-'));
    socketPath = path.join(dir, 's.sock');
    clients = [];
    embedded = new Map();
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await handle?.close();
    await entries?.dispose();
    handle = undefined;
    entries = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startDaemon(idleTimeoutMs = 0): Promise<void> {
    entries = new VaultEntries({
      // Vectors of the profile's own width, so the real ShardStore accepts them; no model loads.
      embedderFor: (key) => async (texts) => {
        embedded.set(key, (embedded.get(key) ?? 0) + texts.length);
        return texts.map(() => {
          const v = new Array<number>(MODEL_PROFILES[key].dims).fill(0);
          v[0] = 1;
          return v;
        });
      },
      idleTimeoutMs,
      createEntry: (opts) => createVaultEntry({ ...opts, debounceMs: DEBOUNCE_MS }),
      warn: () => {},
    });
    const registry = new ServiceRegistry();
    registry.register('vault', createVaultService(entries));
    const live = entries;
    registry.register(
      'daemon',
      createDaemonService({
        name: 'neuro-vault-mcp',
        version: 'test',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        idleTimeoutMin: 0,
        clients: () => handle?.clients() ?? 0,
        embedLoaded: () => [],
        vaultInfo: () => live.info(),
        requestShutdown: () => {},
      }),
    );
    handle = await startDaemonServer({
      socketPath,
      registry,
      idleTimeoutMs: 0,
      onIdle: () => {},
    });
  }

  async function connect(): Promise<LineClient> {
    const client = await LineClient.connect(socketPath);
    clients.push(client);
    return client;
  }

  function makeVault(
    name: string,
    files: Record<string, string> = {
      'a.md': noteBody('alpha'),
      'b.md': noteBody('beta'),
      'c.md': noteBody('gamma'),
    },
  ): string {
    const root = path.join(dir, name);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    return root;
  }

  const attach = (c: LineClient, vault: string, profiles: string[] = [PROFILE]) =>
    c.result<Attached>('vault.attach', { vault, profiles });
  const status = (c: LineClient, vault: string, profile = PROFILE) =>
    c.result<Status>('vault.status', { vault, profile });
  const info = async (c: LineClient) =>
    (await c.result<DaemonInfoResult>('daemon.info')).services.vault;
  const untilReady = (c: LineClient, vault: string, profile = PROFILE) =>
    poll(
      () => status(c, vault, profile),
      (s) => s.state === 'ready',
    );

  it('attach then status goes indexing to ready', { timeout: 15_000 }, async () => {
    await startDaemon();
    const c = await connect();
    const attached = await attach(c, makeVault('notes'));

    expect(attached.profiles[PROFILE]).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(await untilReady(c, attached.vault)).toEqual({ state: 'ready' });
    expect(embedded.get(PROFILE)).toBeGreaterThanOrEqual(3);
    const [vault] = await info(c);
    expect(vault.profiles[0]).toMatchObject({ profile: PROFILE, state: 'ready', notes: 3 });
    expect(vault.profiles[0].last_reconcile).toMatchObject({ added: 3, changed: 0, removed: 0 });
  });

  it('two connections share one entry', { timeout: 15_000 }, async () => {
    await startDaemon();
    const a = await connect();
    const b = await connect();
    const root = makeVault('notes');

    const first = await attach(a, root);
    const second = await attach(b, root);

    expect(second.vault).toBe(first.vault);
    const listed = await info(a);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ vault: first.vault, clients: 2 });
    await untilReady(b, first.vault);
    // One pass built it for both: the second attach queues at most one more pass on the same
    // loop, and that pass re-embeds nothing.
    const built = embedded.get(PROFILE);
    await new Promise((r) => setTimeout(r, 300));
    expect(embedded.get(PROFILE)).toBe(built);
    expect((await info(b))[0].profiles[0]).toMatchObject({
      notes: 3,
      last_reconcile: { changed: 0, removed: 0 },
    });
  });

  it('profiles [] attaches without a corpus', { timeout: 15_000 }, async () => {
    await startDaemon();
    const c = await connect();
    const root = makeVault('notes');

    const attached = await attach(c, root, []);

    expect(attached.profiles).toEqual({});
    expect(await info(c)).toEqual([expect.objectContaining({ clients: 1, profiles: [] })]);
    // A pass would have created the directory (the lock lives there); give a stray one time to run.
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(path.join(root, '.neuro-vault', 'corpus'))).toBe(false);
    expect(embedded.size).toBe(0);
  });

  it(
    'a note write triggers one pass; an excluded write triggers none',
    { timeout: 25_000 },
    async () => {
      await startDaemon();
      const c = await connect();
      const root = makeVault('notes', {
        'a.md': noteBody('alpha'),
        'b.md': noteBody('beta'),
        'Archive/old.md': noteBody('old'),
        '.neuro-vault/config.json': JSON.stringify({ exclusions: ['Archive'] }),
      });
      const attached = await attach(c, root);
      await untilReady(c, attached.vault);
      const lastPass = async () => (await info(c))[0].profiles[0].last_reconcile;
      const first = await lastPass();
      // Excluded notes never reached the corpus.
      expect(first).toMatchObject({ added: 2 });
      // The watcher's initial scan is still starting when the pass finishes.
      await new Promise((r) => setTimeout(r, 500));

      fs.writeFileSync(path.join(root, 'a.md'), noteBody('alpha, rewritten'));
      const second = await poll(lastPass, (last) => last?.at !== first?.at, 10_000);
      expect(second).toMatchObject({ added: 0, changed: 1, removed: 0 });
      // Settled: the write that was reported once is not reported again.
      await new Promise((r) => setTimeout(r, WRITE_FINISH_MS));
      expect((await lastPass())?.at).toBe(second?.at);

      fs.writeFileSync(path.join(root, 'Archive', 'old.md'), noteBody('old, rewritten'));
      fs.writeFileSync(path.join(root, 'Archive', 'new.md'), noteBody('new'));
      // Long enough for a wrongly forwarded event to be reported, debounced and its pass to
      // finish, so an unchanged `at` means no pass ran (the scan is scope-filtered, so such a
      // pass would still move `at`).
      await new Promise((r) =>
        setTimeout(r, WRITE_FINISH_MS + WRITE_POLL_MS + DEBOUNCE_MS + PASS_BUDGET_MS),
      );
      expect((await lastPass())?.at).toBe(second?.at);
    },
  );

  it('close plus idle timeout drops the entry', { timeout: 15_000 }, async () => {
    await startDaemon(200);
    const a = await connect();
    const observer = await connect();
    const attached = await attach(a, makeVault('notes'));
    await untilReady(a, attached.vault);
    expect(await info(observer)).toHaveLength(1);

    await a.close();

    // Detached at once, still held for the idle timeout...
    await poll(
      () => info(observer),
      (listed) => listed[0]?.clients === 0,
    );
    // ...then gone.
    expect(
      await poll(
        () => info(observer),
        (listed) => listed.length === 0,
      ),
    ).toEqual([]);
  });

  it('answers NOT_ATTACHED and VAULT_UNAVAILABLE with data.code', { timeout: 15_000 }, async () => {
    await startDaemon();
    const a = await connect();
    const b = await connect();
    const attached = await attach(a, makeVault('notes'));

    // B never attached what A did, and nothing is attached under another profile either.
    expect(await b.errorCode('vault.status', { vault: attached.vault, profile: PROFILE })).toBe(
      'NOT_ATTACHED',
    );
    expect(
      await a.errorCode('vault.status', { vault: attached.vault, profile: OTHER_PROFILE }),
    ).toBe('NOT_ATTACHED');
    expect(
      await a.errorCode('vault.attach', { vault: path.join(dir, 'missing'), profiles: [] }),
    ).toBe('VAULT_UNAVAILABLE');
    expect(await a.errorCode('vault.attach', { vault: 'relative/vault', profiles: [] })).toBe(
      'VAULT_UNAVAILABLE',
    );
    expect(await a.errorCode('vault.attach', { vault: attached.vault, profiles: ['nope'] })).toBe(
      'UNKNOWN_PROFILE',
    );
    expect(
      await a.errorCode('vault.attach', { vault: attached.vault, profiles: [], exclusions: [] }),
    ).toBe('INVALID_PARAMS');
    // Every refusal left the daemon serving.
    expect(await status(a, attached.vault)).toBeDefined();
  });

  it(
    'a vault directory that vanishes is unavailable and does not touch another vault',
    { timeout: 20_000 },
    async () => {
      await startDaemon();
      const c = await connect();
      const doomed = makeVault('doomed');
      const sibling = makeVault('sibling');
      const a = await attach(c, doomed);
      const b = await attach(c, sibling);
      await untilReady(c, a.vault);
      await untilReady(c, b.vault);
      await new Promise((r) => setTimeout(r, 500));

      // The watcher sees the notes go and asks for a pass, as it would if a sync tool or an
      // unmounted volume took the directory away.
      fs.rmSync(doomed, { recursive: true, force: true });

      const gone = await poll(
        () => status(c, a.vault),
        (s) => s.state === 'unavailable',
        10_000,
      );
      expect(gone.reason).toBeTruthy();
      // Not resurrected as an empty vault by the pass's own lock directory.
      expect(fs.existsSync(doomed)).toBe(false);
      expect(await status(c, b.vault)).toEqual({ state: 'ready' });
      // And the daemon still serves new attaches.
      const later = await attach(await connect(), sibling);
      expect(later.vault).toBe(b.vault);
    },
  );
});
