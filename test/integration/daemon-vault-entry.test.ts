import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ServiceRegistry, type DaemonInfoResult } from '../../src/daemon/protocol.js';
import { createDaemonService } from '../../src/daemon/services/daemon.js';
import { createCorpusService } from '../../src/daemon/services/corpus.js';
import { createLexicalService } from '../../src/daemon/services/lexical.js';
import { createVaultService } from '../../src/daemon/services/vault.js';
import { startDaemonServer, type DaemonServerHandle } from '../../src/daemon/socket-server.js';
import { MODEL_PROFILES } from '../../src/lib/model-profiles.js';
import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import { VaultEntries } from '../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../src/lib/vault-entry/vault-entry.js';
import { LegacyLexicalIndex } from '../lib/obsidian/lexical/_legacy-lexical-index.js';
import {
  FIXTURE_PATHS,
  QUERY_SETS,
  writeFixtureVault,
} from '../lib/obsidian/lexical/_fixture-vault.js';

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
  /** While set, the fake embedder waits for it: a pass cannot finish, so the corpus stays `indexing`. */
  let embedGate: Promise<void> | undefined;

  beforeEach(() => {
    // Short enough for the 104-byte sun_path limit of macOS.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-ve-'));
    socketPath = path.join(dir, 's.sock');
    clients = [];
    embedded = new Map();
    embedGate = undefined;
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
        await embedGate;
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
    registry.register('corpus', createCorpusService(entries));
    registry.register('lexical', createLexicalService(entries));
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
      'INVALID_PARAMS',
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

  describe('lexical reads', () => {
    type LexicalAnswer = {
      notes: { path: string; matches: unknown[]; matched_queries: string[] }[];
      truncated: boolean;
      per_query_counts: Record<string, number>;
      per_query_token_counts: Record<string, Record<string, number>>;
      total_notes: number;
    };

    it(
      'lexical.search after profiles [] returns the full ranking',
      { timeout: 15_000 },
      async () => {
        await startDaemon();
        const c = await connect();
        const root = path.join(dir, 'fixture');
        await writeFixtureVault(root);
        const attached = await attach(c, root, []);
        const reader = new FsVaultReader({ vaultRoot: root });
        const graph = new WikilinkGraphIndex({ reader });
        await graph.ensureFresh();
        const oracle = new LegacyLexicalIndex({ vaultRoot: root, reader });

        // At once after the attach: the search waits for the warm-up, it is not refused.
        for (const queries of QUERY_SETS) {
          const limits = { noteCap: 10, perNoteCap: 3 };
          const answer = await c.result<LexicalAnswer>('lexical.search', {
            vault: attached.vault,
            queries,
            note_cap: limits.noteCap,
            per_note_cap: limits.perNoteCap,
          });
          const expected = await oracle.search({
            queries,
            ...limits,
            getBacklinkCount: (p) => graph.getBacklinkCount(p),
          });

          expect(answer.total_notes, JSON.stringify(queries)).toBe(FIXTURE_PATHS.length);
          expect(answer.total_notes).toBe(expected.totalNotes);
          expect(
            answer.notes.map(({ matched_queries, ...note }) => ({
              ...note,
              matchedQueries: matched_queries,
            })),
          ).toEqual(expected.notes);
          expect(answer.truncated).toBe(expected.truncated);
          expect(answer.per_query_counts).toEqual(expected.perQueryCounts);
          expect(answer.per_query_token_counts).toEqual(expected.perQueryTokenCounts);
        }
      },
    );

    it('allowed narrows the ranking; an empty list matches nothing', async () => {
      await startDaemon();
      const c = await connect();
      const root = path.join(dir, 'fixture');
      await writeFixtureVault(root);
      const attached = await attach(c, root, []);
      const search = (allowed: string[]) =>
        c.result<LexicalAnswer>('lexical.search', {
          vault: attached.vault,
          queries: ['пошук'],
          allowed,
          note_cap: 10,
          per_note_cap: 3,
        });

      const some = await search(['Гібридний пошук.md']);
      expect(some.notes.map((n) => n.path)).toEqual(['Гібридний пошук.md']);
      expect((await search([])).notes).toEqual([]);
    });

    it('a lexical call makes a client', async () => {
      await startDaemon();
      const observer = await connect();
      const caller = await connect();

      // Refused (nothing attached), but still a call on a service namespace.
      expect(
        await caller.errorCode('lexical.search', {
          vault: path.join(dir, 'none'),
          queries: ['q'],
          note_cap: 1,
          per_note_cap: 1,
        }),
      ).toBe('NOT_ATTACHED');

      expect((await observer.result<DaemonInfoResult>('daemon.info')).clients).toBe(1);
    });
  });

  describe('corpus reads', () => {
    type NoteAnswer = { hits: ({ path: string; similarity: number }[] | null)[] };
    type BlockAnswer = {
      hits: ({ path: string; heading: string; lines: number[]; similarity: number }[] | null)[];
    };
    const query = (dims = MODEL_PROFILES[PROFILE].dims) => {
      const v = new Array<number>(dims).fill(0);
      v[0] = 1;
      return v;
    };
    const base = { profile: PROFILE, threshold: 0.5 };

    async function readyVault(c: LineClient) {
      const attached = await attach(
        c,
        makeVault('notes', {
          'a.md': noteBody('alpha'),
          'b.md': noteBody('beta'),
          'c.md': noteBody('gamma'),
          'short.md': '# short\n\nToo short to embed.\n',
        }),
      );
      await untilReady(c, attached.vault);
      return attached.vault;
    }

    it(
      'one list per anchor, null for a note too short to carry a vector',
      { timeout: 15_000 },
      async () => {
        await startDaemon();
        const c = await connect();
        const vault = await readyVault(c);

        const answer = await c.result<NoteAnswer>('corpus.nearest', {
          ...base,
          vault,
          anchors: [
            { vector: query() },
            { path: 'short.md' },
            { path: 'b.md' },
            { vector: query().map((x) => -x) },
          ],
        });

        expect(answer.hits).toHaveLength(4);
        // Equal similarity: ordered by path.
        expect(answer.hits[0]?.map((hit) => hit.path)).toEqual(['a.md', 'b.md', 'c.md']);
        expect(answer.hits[1]).toBeNull();
        expect(answer.hits[2]?.map((hit) => hit.path)).toEqual(['a.md', 'b.md', 'c.md']);
        expect(answer.hits[3]).toEqual([]);
      },
    );

    it('allowed and exclude narrow before the limit', { timeout: 15_000 }, async () => {
      await startDaemon();
      const c = await connect();
      const vault = await readyVault(c);
      const nearest = async (extra: Record<string, unknown>) =>
        (
          await c.result<NoteAnswer>('corpus.nearest', {
            ...base,
            vault,
            anchors: [{ vector: query() }],
            ...extra,
          })
        ).hits[0]?.map((hit) => hit.path);

      expect(await nearest({ limit: 1 })).toEqual(['a.md']);
      expect(await nearest({ limit: 1, allowed: ['c.md', 'b.md'] })).toEqual(['b.md']);
      expect(await nearest({ limit: 2, exclude: ['a.md'] })).toEqual(['b.md', 'c.md']);
    });

    it('nearestBlocks answers blocks of the given notes only', { timeout: 15_000 }, async () => {
      await startDaemon();
      const c = await connect();
      const vault = await readyVault(c);

      const answer = await c.result<BlockAnswer>('corpus.nearestBlocks', {
        ...base,
        vault,
        anchors: [{ vector: query() }, { path: 'short.md' }],
        paths: ['b.md'],
      });

      expect(answer.hits[0]?.map((hit) => hit.path)).toEqual(['b.md']);
      expect(answer.hits[0]?.[0]).toMatchObject({ heading: 'beta', lines: [1, 4] });
      expect(answer.hits[1]).toBeNull();
    });

    it('corpus.nearest returns no vectors', { timeout: 15_000 }, async () => {
      await startDaemon();
      const c = await connect();
      const vault = await readyVault(c);

      const notes = await c.call('corpus.nearest', {
        ...base,
        vault,
        anchors: [{ vector: query() }, { path: 'a.md' }],
      });
      const blocks = await c.call('corpus.nearestBlocks', {
        ...base,
        vault,
        anchors: [{ path: 'a.md' }],
        paths: ['a.md', 'b.md'],
      });

      // No array of numbers anywhere in the answer, in particular none as wide as the corpus.
      const numberArrays = (value: unknown): unknown[][] =>
        Array.isArray(value)
          ? [
              ...(value.some((x) => typeof x === 'number') ? [value] : []),
              ...value.flatMap(numberArrays),
            ]
          : typeof value === 'object' && value !== null
            ? Object.values(value).flatMap(numberArrays)
            : [];
      for (const response of [notes, blocks]) {
        expect('result' in response).toBe(true);
        // `lines` is the one pair of numbers a block hit carries.
        expect(numberArrays(response).filter((array) => array.length > 2)).toEqual([]);
      }
    });

    it(
      'answers CORPUS_NOT_READY with the status while the corpus builds',
      { timeout: 15_000 },
      async () => {
        let release!: () => void;
        embedGate = new Promise((resolve) => {
          release = resolve;
        });
        await startDaemon();
        const c = await connect();
        const vault = (await attach(c, makeVault('notes'))).vault;

        const response = await c.call('corpus.nearest', {
          ...base,
          vault,
          anchors: [{ vector: query() }],
        });

        expect('error' in response).toBe(true);
        const data = ('error' in response ? response.error.data : undefined) as {
          code: string;
          status: Status;
        };
        expect(data.code).toBe('CORPUS_NOT_READY');
        expect(data.status.state).toBe('indexing');
        release();
        await untilReady(c, vault);
      },
    );

    it(
      'refuses what the connection did not attach, an unknown profile and a wrong width',
      { timeout: 15_000 },
      async () => {
        await startDaemon();
        const a = await connect();
        const b = await connect();
        const vault = await readyVault(a);
        const call = (client: LineClient, extra: Record<string, unknown>) =>
          client.errorCode('corpus.nearest', {
            ...base,
            vault,
            anchors: [{ vector: query() }],
            ...extra,
          });

        expect(await call(b, {})).toBe('NOT_ATTACHED');
        expect(await call(a, { profile: OTHER_PROFILE })).toBe('NOT_ATTACHED');
        expect(await call(a, { profile: 'nope' })).toBe('UNKNOWN_PROFILE');
        expect(
          await call(a, { anchors: [{ vector: query(MODEL_PROFILES[OTHER_PROFILE].dims) }] }),
        ).toBe('INVALID_PARAMS');
        expect(await call(a, { anchors: [{ vector: [1, 2] }] })).toBe('INVALID_PARAMS');
        // Every refusal left the connection serving.
        expect(
          (await a.result<NoteAnswer>('corpus.nearest', { ...base, vault, anchors: [] })).hits,
        ).toEqual([]);
      },
    );
  });
});
