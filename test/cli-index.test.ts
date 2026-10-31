import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runIndexCommand, type IndexCommandDeps } from '../src/cli-index.js';
import type { ReconcileDeps, ReconcileOptions } from '../src/lib/obsidian/corpus/reconcile.js';
import { CorpusLockTimeoutError } from '../src/lib/obsidian/corpus/reconcile-lock.js';
import {
  DEFAULT_MODEL_KEY,
  resolveModelProfile,
  type ModelProfile,
} from '../src/lib/model-profiles.js';
import { TEST_EMBEDDING_IDENTITY, TEST_IDENTITY } from './_identity.js';

const profile = resolveModelProfile(DEFAULT_MODEL_KEY);

interface FakeStream {
  chunks: string[];
  isTTY: boolean;
  write(s: string): boolean;
}
function fakeStream(isTTY: boolean): FakeStream {
  const chunks: string[] = [];
  return { chunks, isTTY, write: (s) => (chunks.push(s), true) };
}

const vaultA = {
  name: 'VaultA',
  path: '/abs/VaultA',
};
const vaultB = {
  name: 'VaultB',
  path: '/abs/VaultB',
};

function okSummary(overrides = {}) {
  return {
    total: 3,
    embedded: 3,
    added: 0,
    reused: 0,
    renamed: 0,
    deleted: 0,
    failed: 0,
    ...overrides,
  };
}

function makeDeps(reconcile: IndexCommandDeps['reconcile'], tty = false) {
  return {
    reconcile,
    createEmbedder: () => ({
      identity: TEST_EMBEDDING_IDENTITY,
      embedDocuments: async (ts: string[]) => ts.map(() => [0.1, 0.2]),
    }),
    stdout: fakeStream(tty),
    stderr: fakeStream(false),
  };
}

describe('runIndexCommand', () => {
  it('reconciles each vault sequentially with one shared embedDocuments function', async () => {
    const calls: string[] = [];
    const embeds: unknown[] = [];
    const identities: unknown[] = [];
    const reconcile = vi.fn(async (deps: ReconcileDeps) => {
      calls.push(deps.vaultRoot);
      embeds.push(deps.embedDocuments);
      identities.push(deps.identity);
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: false },
      deps,
    );
    expect(code).toBe(0);
    expect(calls).toEqual(['/abs/VaultA', '/abs/VaultB']);
    expect(embeds[0]).toBe(embeds[1]); // one EmbeddingService for the run
    expect(identities).toEqual([TEST_IDENTITY, TEST_IDENTITY]); // the embedder's, not a constant
  });

  it('exit code is 1 when any vault has failed notes, summaries still printed', async () => {
    const reconcile = vi
      .fn()
      .mockResolvedValueOnce(okSummary())
      .mockResolvedValueOnce(okSummary({ embedded: 2, failed: 1 }));
    const deps = makeDeps(reconcile);
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: false },
      deps,
    );
    expect(code).toBe(1);
    const out = deps.stdout.chunks.join('');
    expect(out).toContain('VaultA');
    expect(out).toContain('failed=1');
  });

  it('a fatal error goes to stderr, later vaults still run, exit code 1', async () => {
    const reconcile = vi
      .fn()
      .mockRejectedValueOnce(new Error('scope exploded'))
      .mockResolvedValueOnce(okSummary());
    const deps = makeDeps(reconcile);
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: false },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.stderr.chunks.join('')).toContain('scope exploded');
    expect(deps.stdout.chunks.join('')).toContain('VaultB');
  });

  it('non-TTY progress prints at most one line per 10% step', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      for (let i = 1; i <= 100; i++) opts?.onProgress?.({ indexed: i, total: 100 });
      return okSummary({ total: 100, embedded: 100 });
    });
    const deps = makeDeps(reconcile, false);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    const progressLines = deps.stdout.chunks.filter((c) => c.startsWith('indexing'));
    expect(progressLines.length).toBeLessThanOrEqual(11);
  });

  it('TTY progress rewrites one line in place', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onProgress?.({ indexed: 1, total: 2 });
      opts?.onProgress?.({ indexed: 2, total: 2 });
      return okSummary({ total: 2, embedded: 2 });
    });
    const deps = makeDeps(reconcile, true);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    const out = deps.stdout.chunks.join('');
    expect(out).toContain('\rindexing VaultA: 1/2');
    expect(out).toContain('\rindexing VaultA: 2/2');
  });

  it('summary line carries all six counts', async () => {
    const reconcile = vi.fn(async () =>
      okSummary({ total: 5, embedded: 1, reused: 2, renamed: 1, deleted: 3, failed: 0 }),
    );
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    const out = deps.stdout.chunks.join('');
    expect(out).toMatch(/total=5 embedded=1 reused=2 renamed=1 deleted=3 failed=0/);
  });

  it('terminates TTY progress line with newline before writing fatal error to stderr', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onProgress?.({ indexed: 5, total: 10 });
      throw new Error('storage corrupted');
    });
    const deps = makeDeps(reconcile, true);
    const code = await runIndexCommand(
      { vaults: [vaultA], model: profile, shared: false, prune: false },
      deps,
    );
    expect(code).toBe(1);
    // Verify that a newline was written to stdout to terminate the progress line
    expect(deps.stdout.chunks).toContain('\n');
    // Verify the error went to stderr
    expect(deps.stderr.chunks.join('')).toContain('storage corrupted');
  });

  it('builds its one embedder from the selected profile', async () => {
    const createEmbedder = vi.fn((_profile: ModelProfile) => ({
      identity: TEST_EMBEDDING_IDENTITY,
      embedDocuments: async (ts: string[]) => ts.map(() => [0.1]),
    }));
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), createEmbedder };
    const granite = resolveModelProfile('granite-97m');
    await runIndexCommand(
      { vaults: [vaultA, vaultB], model: granite, shared: false, prune: false },
      deps,
    );
    expect(createEmbedder).toHaveBeenCalledTimes(1);
    expect(createEmbedder).toHaveBeenCalledWith(granite);
  });

  it('writes the same corpus identity whether the model is shared or in-process', async () => {
    const identities: unknown[] = [];
    const reconcile = vi.fn(async (d: ReconcileDeps) => {
      identities.push(d.identity);
      return okSummary();
    });
    for (const shared of [true, false]) {
      // The default embedder: nothing is probed or loaded until a document is embedded.
      const { createEmbedder: _unused, ...deps } = makeDeps(reconcile);
      await runIndexCommand({ vaults: [vaultA], model: profile, shared, prune: false }, deps);
    }
    expect(identities).toHaveLength(2);
    expect(identities[0]).toEqual(identities[1]);
    expect(identities[0]).toMatchObject({ model_key: profile.key });
  });

  it('announces a rebuild before the vault’s progress', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onRebuild?.({
        stored: { ...TEST_IDENTITY, model_key: 'harrier-270m', embed_version: 2 },
        active: TEST_IDENTITY,
      });
      opts?.onProgress?.({ indexed: 1, total: 1 });
      return okSummary({ total: 1, embedded: 1 });
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stdout.chunks[0]).toBe(
      'rebuilding VaultA: corpus was indexed with harrier-270m (embed_version 2); active model is bge-micro-v2 (embed_version 3)\n',
    );
  });

  it('prints no rebuild line when the corpus matches', async () => {
    const deps = makeDeps(vi.fn(async () => okSummary()));
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stdout.chunks.join('')).not.toContain('rebuilding');
  });

  it('prunes other models after reconciling, reporting what it removed', async () => {
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push('reconcile');
      return okSummary();
    });
    const prune = vi.fn(async (_root: string, _keep: string) => {
      order.push('prune');
      return ['notes', 'granite-97m'];
    });
    const deps = { ...makeDeps(reconcile), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA], model: profile, shared: false, prune: true },
      deps,
    );
    expect(code).toBe(0);
    expect(order).toEqual(['reconcile', 'prune']);
    expect(prune).toHaveBeenCalledWith('/abs/VaultA', TEST_EMBEDDING_IDENTITY.model_key, {
      onLockWait: expect.any(Function),
    });
    expect(deps.stdout.chunks.at(-1)).toBe('pruned VaultA: removed granite-97m, notes\n');
  });

  it('says so when there is nothing to prune', async () => {
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune: vi.fn(async () => []) };
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: true }, deps);
    expect(deps.stdout.chunks.at(-1)).toBe('pruned VaultA: nothing to remove\n');
  });

  it('never prunes without the flag', async () => {
    const prune = vi.fn(async () => []);
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune };
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(prune).not.toHaveBeenCalled();
  });

  it('does not prune a vault whose reconcile failed every note, and says why', async () => {
    // The real offline-first-run shape: reconcile contains embed failures and returns.
    const reconcile = vi.fn(async () => okSummary({ total: 3, embedded: 0, failed: 3 }));
    const prune = vi.fn(async () => ['granite-97m']);
    const deps = { ...makeDeps(reconcile), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA], model: profile, shared: false, prune: true },
      deps,
    );
    expect(code).toBe(1);
    expect(prune).not.toHaveBeenCalled();
    expect(deps.stderr.chunks.join('')).toContain('not pruning VaultA: no note was indexed');
    expect(deps.stdout.chunks.join('')).not.toContain('pruned');
  });

  it('still prunes a vault with no notes in scope', async () => {
    const reconcile = vi.fn(async () => okSummary({ total: 0, embedded: 0 }));
    const prune = vi.fn(async () => ['granite-97m']);
    const deps = { ...makeDeps(reconcile), prune };
    expect(
      await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: true }, deps),
    ).toBe(0);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('does not prune a vault whose reconcile threw', async () => {
    const reconcile = vi.fn(async (d: ReconcileDeps) => {
      if (d.vaultRoot === '/abs/VaultA') throw new Error('model download failed');
      return okSummary();
    });
    const prune = vi.fn(async () => []);
    const deps = { ...makeDeps(reconcile), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: true },
      deps,
    );
    expect(code).toBe(1);
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith('/abs/VaultB', TEST_EMBEDDING_IDENTITY.model_key, {
      onLockWait: expect.any(Function),
    });
  });

  it('a prune failure is fatal for that vault only', async () => {
    const prune = vi.fn(async (root: string) => {
      if (root === '/abs/VaultA') throw new Error('EACCES');
      return [];
    });
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune };
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: true },
      deps,
    );
    expect(code).toBe(1);
    expect(deps.stderr.chunks.join('')).toContain('index VaultA: EACCES');
    expect(deps.stdout.chunks.join('')).toContain('pruned VaultB: nothing to remove');
  });

  it('a lock held past the bound fails that vault, naming the lock file and holder', async () => {
    const reconcile = vi.fn(async (d: ReconcileDeps) => {
      if (d.vaultRoot === '/abs/VaultA') {
        throw new CorpusLockTimeoutError(
          '/abs/VaultA/.neuro-vault/corpus/reconcile.lock',
          4242,
          1_800_000,
        );
      }
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    const code = await runIndexCommand(
      { vaults: [vaultA, vaultB], model: profile, shared: false, prune: false },
      deps,
    );
    expect(code).toBe(1);
    const stderr = deps.stderr.chunks.join('');
    expect(stderr).toContain('index VaultA:');
    expect(stderr).toContain('reconcile.lock');
    expect(stderr).toContain('pid 4242');
    expect(deps.stdout.chunks.join('')).toContain('indexed VaultB:');
  });

  it('reports a wait for another process on stderr, not stdout', async () => {
    const reconcile = vi.fn(async (_d: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onLockWait?.({ holderPid: 4242, holderHost: null });
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242) to finish with VaultA…\n',
    ]);
    expect(deps.stdout.chunks.join('')).not.toContain('waiting');
  });

  it('names the holder’s host when it is not this one', async () => {
    const reconcile = vi.fn(async (_d: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onLockWait?.({ holderPid: 4242, holderHost: 'other-host' });
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242 on other-host) to finish with VaultA…\n',
    ]);
  });

  it('omits the host when the holder is on this one', async () => {
    const reconcile = vi.fn(async (_d: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onLockWait?.({ holderPid: 4242, holderHost: hostname() });
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242) to finish with VaultA…\n',
    ]);
  });

  it('names no holder when its pid is unknown', async () => {
    const reconcile = vi.fn(async (_d: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onLockWait?.({ holderPid: null, holderHost: null });
      return okSummary();
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: false }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process to finish with VaultA…\n',
    ]);
  });

  it('hands the prune the same wait line', async () => {
    const prune = vi.fn(
      async (
        _root: string,
        _keep: string,
        opts?: Parameters<NonNullable<IndexCommandDeps['prune']>>[2],
      ) => {
        opts?.onLockWait?.({ holderPid: 4242, holderHost: null });
        return [];
      },
    );
    const deps = { ...makeDeps(vi.fn(async () => okSummary())), prune };
    await runIndexCommand({ vaults: [vaultA], model: profile, shared: false, prune: true }, deps);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242) to finish with VaultA…\n',
    ]);
  });

  it('announces a prune that waits for the lock, then prunes once it is free', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-index-prune-'));
    const corpus = path.join(root, '.neuro-vault/corpus');
    const keep = TEST_EMBEDDING_IDENTITY.model_key;
    for (const dir of [keep, 'granite-97m']) {
      await mkdir(path.join(corpus, dir), { recursive: true });
      await writeFile(path.join(corpus, dir, 'manifest.json'), '{}');
    }
    // A holder on another host is always live; it releases shortly.
    const lockFile = path.join(corpus, 'reconcile.lock');
    await writeFile(lockFile, JSON.stringify({ host: 'other-host', pid: 4242, token: 't' }));
    const released = new Promise<void>((resolve) =>
      setTimeout(() => void rm(lockFile).then(resolve), 120),
    );
    const deps = makeDeps(vi.fn(async () => okSummary()));
    const code = await runIndexCommand(
      { vaults: [{ name: 'VaultA', path: root }], model: profile, shared: false, prune: true },
      deps,
    );
    await released;
    expect(code).toBe(0);
    expect(deps.stderr.chunks).toEqual([
      'waiting for another neuro-vault process (pid 4242 on other-host) to finish with VaultA…\n',
    ]);
    expect(deps.stdout.chunks.at(-1)).toBe('pruned VaultA: removed granite-97m\n');
    expect((await readdir(corpus)).sort()).toEqual([keep]);
  });

  it('the index module never imports the server module', async () => {
    const source = await readFile(new URL('../src/cli-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\/server\.js'/);
    expect(source).not.toMatch(/@modelcontextprotocol/);
  });
});
