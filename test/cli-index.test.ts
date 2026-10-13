import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { runIndexCommand, type IndexCommandDeps } from '../src/cli-index.js';
import type { ReconcileDeps, ReconcileOptions } from '../src/lib/obsidian/corpus/reconcile.js';
import {
  DEFAULT_MODEL_KEY,
  resolveModelProfile,
  type ModelProfile,
} from '../src/modules/semantic/model-profiles.js';
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
  return { total: 3, embedded: 3, reused: 0, renamed: 0, deleted: 0, failed: 0, ...overrides };
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
    const code = await runIndexCommand({ vaults: [vaultA, vaultB], model: profile }, deps);
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
    const code = await runIndexCommand({ vaults: [vaultA, vaultB], model: profile }, deps);
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
    const code = await runIndexCommand({ vaults: [vaultA, vaultB], model: profile }, deps);
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
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
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
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    const out = deps.stdout.chunks.join('');
    expect(out).toContain('\rindexing VaultA: 1/2');
    expect(out).toContain('\rindexing VaultA: 2/2');
  });

  it('summary line carries all six counts', async () => {
    const reconcile = vi.fn(async () =>
      okSummary({ total: 5, embedded: 1, reused: 2, renamed: 1, deleted: 3, failed: 0 }),
    );
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    const out = deps.stdout.chunks.join('');
    expect(out).toMatch(/total=5 embedded=1 reused=2 renamed=1 deleted=3 failed=0/);
  });

  it('terminates TTY progress line with newline before writing fatal error to stderr', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onProgress?.({ indexed: 5, total: 10 });
      throw new Error('storage corrupted');
    });
    const deps = makeDeps(reconcile, true);
    const code = await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
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
    await runIndexCommand({ vaults: [vaultA, vaultB], model: granite }, deps);
    expect(createEmbedder).toHaveBeenCalledTimes(1);
    expect(createEmbedder).toHaveBeenCalledWith(granite);
  });

  it('announces a rebuild before the vault’s progress', async () => {
    const reconcile = vi.fn(async (_deps: ReconcileDeps, opts?: ReconcileOptions) => {
      opts?.onRebuild?.({
        stored: { ...TEST_IDENTITY, model_key: 'harrier-270m', embed_version: 2, created: 'x' },
        active: TEST_IDENTITY,
      });
      opts?.onProgress?.({ indexed: 1, total: 1 });
      return okSummary({ total: 1, embedded: 1 });
    });
    const deps = makeDeps(reconcile);
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    expect(deps.stdout.chunks[0]).toBe(
      'rebuilding VaultA: corpus was indexed with harrier-270m (embed_version 2); active model is bge-micro-v2 (embed_version 2)\n',
    );
  });

  it('prints no rebuild line when the corpus matches', async () => {
    const deps = makeDeps(vi.fn(async () => okSummary()));
    await runIndexCommand({ vaults: [vaultA], model: profile }, deps);
    expect(deps.stdout.chunks.join('')).not.toContain('rebuilding');
  });

  it('the index module never imports the server module', async () => {
    const source = await readFile(new URL('../src/cli-index.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\/server\.js'/);
    expect(source).not.toMatch(/@modelcontextprotocol/);
  });
});
