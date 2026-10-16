import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ICorpusReader } from '../../../src/lib/obsidian/corpus/corpus.js';
import type { BackendStatus } from '../../../src/lib/obsidian/semantic-backend.js';
import { createVaultScope, type VaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import { withReconcileLock } from '../../../src/lib/obsidian/corpus/reconcile.js';
import {
  createReconcileLoop,
  type IReconcileLoop,
} from '../../../src/lib/vault-entry/reconcile-loop.js';
import {
  createVaultEntry,
  type IVaultEntry,
  type IVaultEntryOptions,
  type IVaultInfo,
} from '../../../src/lib/vault-entry/vault-entry.js';
import {
  VaultEntries,
  VaultEntryError,
  type IVaultEntriesDeps,
} from '../../../src/lib/vault-entry/vault-entries.js';
import { MODEL_PROFILES } from '../../../src/lib/model-profiles.js';

const HARRIER = 'harrier-270m';
const GRANITE = 'granite-97m';
const IDLE_MS = 1_000;

const scopeOf = (exclusions: string[] = []) => createVaultScope({ configExclusions: exclusions });

/** Records what VaultEntries asks of an entry; statuses follow the entry's `semantic` flag. */
function fakeEntry(opts: IVaultEntryOptions) {
  const profiles: string[] = [];
  const reader: ICorpusReader = {
    nearest: async () => [],
    nearestBlocks: async () => [],
  };
  const entry = {
    vaultRoot: opts.vaultRoot,
    scope: opts.scope,
    semantic: opts.semantic,
    addProfile: vi.fn((key: string) => {
      profiles.push(key);
    }),
    removeProfile: vi.fn((key: string) => {
      profiles.splice(profiles.indexOf(key), 1);
    }),
    setScope: vi.fn((scope: VaultScope) => {
      entry.scope = scope;
    }),
    setSemantic: vi.fn((enabled: boolean) => {
      entry.semantic = enabled;
    }),
    requestPass: vi.fn(),
    status: (key: string): BackendStatus => {
      if (!profiles.includes(key)) throw new Error(`no profile ${key}`);
      return entry.semantic ? { state: 'indexing', indexed: 0, total: 0 } : { state: 'disabled' };
    },
    reader: () => reader,
    info: (clients: number, idleSince?: string): IVaultInfo => ({
      vault: opts.vaultRoot,
      clients,
      ...(idleSince === undefined ? {} : { idle_since: idleSince }),
      profiles: profiles.map((profile) => ({ profile, state: entry.status(profile).state })),
    }),
    dispose: vi.fn(async () => {}),
  };
  return entry satisfies IVaultEntry;
}

type FakeEntry = ReturnType<typeof fakeEntry>;

const PATHS: Record<string, string> = {
  '/v': '/v',
  '/v/': '/v',
  '/link-to-v': '/v',
  '/w': '/w',
  '/a-file': '/a-file',
};

function setup(over: Partial<IVaultEntriesDeps> = {}) {
  const created: FakeEntry[] = [];
  const loadScope = vi.fn(async (_root: string) => ({ scope: scopeOf(), semantic: true }));
  const warn = vi.fn();
  const entries = new VaultEntries({
    embedderFor: () => async (texts) => texts.map(() => []),
    idleTimeoutMs: IDLE_MS,
    realpath: async (p) => {
      const resolved = PATHS[p];
      if (resolved === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), {
          code: 'ENOENT',
        });
      }
      return resolved;
    },
    isDirectory: async (p) => p !== '/a-file',
    loadScope,
    createEntry: (opts) => {
      const entry = fakeEntry(opts);
      created.push(entry);
      return entry;
    },
    warn,
    ...over,
  });
  disposables.push(entries);
  return { entries, created, loadScope, warn };
}

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VaultEntryError);
    return (err as VaultEntryError).code;
  }
  return undefined;
}

const disposables: VaultEntries[] = [];
const roots: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(disposables.splice(0).map((entries) => entries.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('VaultEntries.attach', () => {
  it('same key for trailing slash and symlink', async () => {
    const s = setup();
    const first = await s.entries.attach(1, '/v/', [HARRIER]);
    const second = await s.entries.attach(2, '/link-to-v', [HARRIER]);
    expect(first.vault).toBe('/v');
    expect(second.vault).toBe('/v');
    expect(s.created).toHaveLength(1);
    expect(s.created[0].addProfile).toHaveBeenCalledTimes(1);
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 2 }]);
  });

  it('two directories get two entries', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    await s.entries.attach(2, '/w', [HARRIER]);
    expect(s.created.map((entry) => entry.vaultRoot)).toEqual(['/v', '/w']);
  });

  it('answers with each profile’s status, without waiting for a load', async () => {
    const s = setup();
    expect(await s.entries.attach(1, '/v', [HARRIER])).toEqual({
      vault: '/v',
      profiles: { [HARRIER]: { state: 'indexing', indexed: 0, total: 0 } },
    });
  });

  it('VAULT_UNAVAILABLE for a missing path', async () => {
    const s = setup();
    const err = await s.entries.attach(1, '/missing', [HARRIER]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultEntryError);
    expect((err as VaultEntryError).code).toBe('VAULT_UNAVAILABLE');
    expect((err as Error).message).toMatch(/ENOENT/);
    expect(s.created).toHaveLength(0);
  });

  it('VAULT_UNAVAILABLE for a file', async () => {
    const s = setup();
    expect(await codeOf(() => s.entries.attach(1, '/a-file', []))).toBe('VAULT_UNAVAILABLE');
    expect(s.created).toHaveLength(0);
  });

  it('VAULT_UNAVAILABLE for a relative path', async () => {
    const s = setup();
    expect(await codeOf(() => s.entries.attach(1, 'v', []))).toBe('VAULT_UNAVAILABLE');
    expect(s.created).toHaveLength(0);
  });

  it('UNKNOWN_PROFILE for a key outside MODEL_PROFILES', async () => {
    const s = setup();
    expect(await codeOf(() => s.entries.attach(1, '/v', [HARRIER, 'not-a-model']))).toBe(
      'UNKNOWN_PROFILE',
    );
    expect(await codeOf(() => s.entries.attach(1, '/v', ['toString']))).toBe('UNKNOWN_PROFILE');
    expect(s.created).toHaveLength(0);
    expect(s.loadScope).not.toHaveBeenCalled();
  });

  it('concurrent attaches of a new vault share one entry', async () => {
    const s = setup();
    const [first, second] = await Promise.all([
      s.entries.attach(1, '/v', [HARRIER]),
      s.entries.attach(2, '/v/', [HARRIER]),
    ]);
    expect(first.vault).toBe('/v');
    expect(second.vault).toBe('/v');
    expect(s.created).toHaveLength(1);
    expect(s.created[0].addProfile).toHaveBeenCalledTimes(1);
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 2 }]);
  });

  it('attaching twice adds a profile and keeps the first', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    const again = await s.entries.attach(1, '/v', [GRANITE]);
    expect(Object.keys(again.profiles)).toEqual([GRANITE]);
    expect(s.created[0].addProfile.mock.calls.map(([key]) => key)).toEqual([HARRIER, GRANITE]);
    expect(s.entries.status(1, '/v', HARRIER).state).toBe('indexing');
    expect(s.entries.status(1, '/v', GRANITE).state).toBe('indexing');
  });

  it('scope change on attach calls setScope', async () => {
    const s = setup();
    const archived = scopeOf(['Archive/**']);
    s.loadScope
      .mockResolvedValueOnce({ scope: scopeOf(), semantic: true })
      .mockResolvedValueOnce({ scope: archived, semantic: true })
      .mockResolvedValueOnce({ scope: scopeOf(['Archive/**']), semantic: true });
    await s.entries.attach(1, '/v', [HARRIER]);
    expect(s.created[0].setScope).not.toHaveBeenCalled();
    await s.entries.attach(2, '/v', [HARRIER]);
    expect(s.created[0].setScope).toHaveBeenCalledExactlyOnceWith(archived);
    // The same patterns again: nothing to restart.
    await s.entries.attach(3, '/v', [HARRIER]);
    expect(s.created[0].setScope).toHaveBeenCalledTimes(1);
  });

  it('the latest attach decides the semantic switch', async () => {
    const s = setup();
    s.loadScope
      .mockResolvedValueOnce({ scope: scopeOf(), semantic: true })
      .mockResolvedValueOnce({ scope: scopeOf(), semantic: false })
      .mockResolvedValueOnce({ scope: scopeOf(), semantic: true });
    await s.entries.attach(1, '/v', [HARRIER]);
    const off = await s.entries.attach(2, '/v', [HARRIER]);
    expect(off.profiles[HARRIER]).toEqual({ state: 'disabled' });
    expect(s.entries.status(1, '/v', HARRIER)).toEqual({ state: 'disabled' });
    const on = await s.entries.attach(3, '/v', [HARRIER]);
    expect(on.profiles[HARRIER].state).toBe('indexing');
    expect(s.created[0].setSemantic.mock.calls).toEqual([[false], [true]]);
  });

  it('every attach that joins requests a pass; one whose connection left does not', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    expect(s.created[0].requestPass).toHaveBeenCalledTimes(1);
    await s.entries.attach(2, '/v', [HARRIER]);
    await s.entries.attach(1, '/v', []);
    expect(s.created[0].requestPass).toHaveBeenCalledTimes(3);
    const pending = s.entries.attach(3, '/v', [HARRIER]);
    s.entries.detach(3);
    await pending;
    expect(s.created[0].requestPass).toHaveBeenCalledTimes(3);
  });

  it('names the vault by the realpath’s basename', async () => {
    const options: IVaultEntryOptions[] = [];
    const s = setup({
      realpath: async () => '/vaults/notes',
      createEntry: (opts) => {
        options.push(opts);
        return fakeEntry(opts);
      },
    });
    await s.entries.attach(1, '/elsewhere', []);
    expect(options[0]).toMatchObject({ vaultRoot: '/vaults/notes', vaultName: 'notes' });
  });
});

describe('VaultEntries over real entries', () => {
  /**
   * A real entry on a temp dir with a do-nothing watcher, so nothing outlives the
   * test — and nothing but an attach ever asks for a pass. Passes are counted at the lock.
   */
  async function realSetup(semantic: boolean) {
    vi.useRealTimers();
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'nv-vault-entries-')));
    roots.push(root);
    const loops: IReconcileLoop[] = [];
    let passes = 0;
    const counting = ((...args: Parameters<typeof withReconcileLock>) => {
      passes += 1;
      return withReconcileLock(...args);
    }) as typeof withReconcileLock;
    const entries = new VaultEntries({
      embedderFor: () => async (texts) => texts.map(() => []),
      idleTimeoutMs: IDLE_MS,
      loadScope: async () => ({ scope: scopeOf(), semantic }),
      createEntry: (opts) =>
        createVaultEntry({
          ...opts,
          createWatcher: () => ({ close: async () => {} }),
          createLoop: (deps) => {
            const loop = createReconcileLoop({ ...deps, withLock: counting });
            loops.push(loop);
            return loop;
          },
        }),
      warn: vi.fn(),
    });
    disposables.push(entries);
    return {
      root,
      entries,
      passes: () => passes,
      settled: () => Promise.all(loops.map((loop) => loop.whenSettled())),
    };
  }

  const exists = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    );

  it('disabled when the vault’s semantic key is false', async () => {
    const { root, entries } = await realSetup(false);
    const result = await entries.attach(1, root, [HARRIER]);
    expect(result).toEqual({ vault: root, profiles: { [HARRIER]: { state: 'disabled' } } });
    await entries.dispose();
    expect(await exists(path.join(root, '.neuro-vault'))).toBe(false);
  });

  it('a re-attach reconciles a warm entry with no watcher: exactly one more pass', async () => {
    const s = await realSetup(true);
    await s.entries.attach(1, s.root, [HARRIER]);
    await s.settled();
    expect(s.passes()).toBe(1);
    await s.entries.attach(2, s.root, [HARRIER]);
    await s.settled();
    expect(s.passes()).toBe(2);
  });

  it('profiles: [] attaches without a corpus', async () => {
    const { root, entries } = await realSetup(true);
    const result = await entries.attach(1, `${root}/`, []);
    expect(result).toEqual({ vault: root, profiles: {} });
    expect(entries.info()).toEqual([{ vault: root, clients: 1, profiles: [] }]);
    await entries.dispose();
    expect(await exists(path.join(root, '.neuro-vault'))).toBe(false);
  });
});

describe('VaultEntries.status and reader', () => {
  it('NOT_ATTACHED for another connection’s vault', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    expect(await codeOf(() => s.entries.status(2, '/v', HARRIER))).toBe('NOT_ATTACHED');
    expect(await codeOf(() => s.entries.reader(2, '/v', HARRIER))).toBe('NOT_ATTACHED');
    expect(await codeOf(() => s.entries.status(1, '/v', GRANITE))).toBe('NOT_ATTACHED');
    expect(await codeOf(() => s.entries.status(1, '/w', HARRIER))).toBe('NOT_ATTACHED');
  });

  it('reader carries the status and the profile’s dims', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    const { reader, status, dims } = s.entries.reader(1, '/v', HARRIER);
    expect(reader).toBe(s.created[0].reader());
    expect(status).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    expect(dims).toBe(MODEL_PROFILES[HARRIER].dims);
  });
});

describe('VaultEntries idle', () => {
  it('detach starts the entry and profile timers; firing drops them', async () => {
    const s = setup({ now: () => new Date('2026-01-02T03:04:05.000Z') });
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    expect(s.entries.info()).toEqual([
      {
        vault: '/v',
        clients: 0,
        idle_since: '2026-01-02T03:04:05.000Z',
        profiles: [{ profile: HARRIER, state: 'indexing' }],
      },
    ]);
    expect(await codeOf(() => s.entries.status(1, '/v', HARRIER))).toBe('NOT_ATTACHED');
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(s.entries.info()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.entries.info()).toEqual([]);
    expect(s.created[0].dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('attach during idle reuses', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    await s.entries.attach(2, '/v', [HARRIER]);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(s.created).toHaveLength(1);
    expect(s.created[0].addProfile).toHaveBeenCalledTimes(1);
    expect(s.created[0].removeProfile).not.toHaveBeenCalled();
    expect(s.created[0].dispose).not.toHaveBeenCalled();
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 1 }]);
    expect(s.entries.info()[0].idle_since).toBeUndefined();
  });

  it('detach before attach settles', async () => {
    const s = setup();
    const pending = s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    await pending;
    expect(s.created).toHaveLength(1);
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 0 }]);
    expect(await codeOf(() => s.entries.status(1, '/v', HARRIER))).toBe('NOT_ATTACHED');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.entries.info()).toEqual([]);
    expect(s.created[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('a detach mid-attach does not leak into a later connection’s attach', async () => {
    const s = setup();
    const pending = s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    await pending;
    await s.entries.attach(2, '/v', [HARRIER]);
    expect(s.entries.status(2, '/v', HARRIER).state).toBe('indexing');
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(s.created[0].dispose).not.toHaveBeenCalled();
  });

  it('an unused profile is freed on its own', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    await s.entries.attach(2, '/v', [GRANITE]);
    s.entries.detach(2);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.created[0].removeProfile).toHaveBeenCalledExactlyOnceWith(GRANITE);
    expect(s.created[0].dispose).not.toHaveBeenCalled();
    expect(s.entries.info()).toMatchObject([
      { vault: '/v', clients: 1, profiles: [{ profile: HARRIER }] },
    ]);
    expect(s.entries.status(1, '/v', HARRIER).state).toBe('indexing');
  });

  it('a profile re-attached during idle is reused', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    await s.entries.attach(2, '/v', [GRANITE]);
    s.entries.detach(2);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    await s.entries.attach(1, '/v', [GRANITE]);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(s.created[0].removeProfile).not.toHaveBeenCalled();
    expect(s.created[0].addProfile).toHaveBeenCalledTimes(2);
  });

  /** A loadScope held open by hand, so a timer can fire while an attach awaits it. */
  function heldScope(s: ReturnType<typeof setup>) {
    let release: (fail?: Error) => void = () => {};
    s.loadScope.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          release = (fail) => (fail ? reject(fail) : resolve({ scope: scopeOf(), semantic: true }));
        }),
    );
    return { release: (fail?: Error) => release(fail) };
  }

  it('an attach awaiting its scope holds an idling entry past its timer', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2);
    const held = heldScope(s);
    const pending = s.entries.attach(2, '/v', [HARRIER]);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    held.release();
    expect((await pending).profiles[HARRIER].state).toBe('indexing');
    expect(s.created).toHaveLength(1);
    expect(s.created[0].removeProfile).not.toHaveBeenCalled();
    expect(s.created[0].dispose).not.toHaveBeenCalled();
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 1 }]);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    expect(s.created[0].dispose).not.toHaveBeenCalled();
  });

  it('a held entry whose attach fails idles out once released', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    const held = heldScope(s);
    const pending = s.entries.attach(2, '/v', [HARRIER]);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    expect(s.created[0].dispose).not.toHaveBeenCalled();
    held.release(new Error('EIO'));
    await expect(pending).rejects.toThrow('EIO');
    expect(s.entries.info()).toEqual([]);
    expect(s.created[0].removeProfile).toHaveBeenCalledExactlyOnceWith(HARRIER);
    expect(s.created[0].dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the first idle time across a detached attach', async () => {
    let clock = Date.parse('2026-01-02T03:04:05.000Z');
    const s = setup({ now: () => new Date(clock) });
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    clock += 60_000;
    const pending = s.entries.attach(2, '/v', [HARRIER]);
    s.entries.detach(2);
    await pending;
    expect(s.entries.info()[0].idle_since).toBe('2026-01-02T03:04:05.000Z');
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.entries.info()).toEqual([]);
  });

  it('a re-attach while a dropped entry disposes waits for that dispose', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    let disposed!: () => void;
    s.created[0].dispose.mockImplementation(
      () => new Promise<void>((resolve) => (disposed = resolve)),
    );
    s.entries.detach(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.created[0].dispose).toHaveBeenCalledTimes(1);
    // One vault directory never has two loops: the new entry waits for the old one to go.
    const pending = s.entries.attach(2, '/v', [HARRIER]);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.created).toHaveLength(1);
    disposed();
    await pending;
    expect(s.created).toHaveLength(2);
    expect(s.entries.info()).toMatchObject([{ vault: '/v', clients: 1 }]);
  });

  it('a failed dispose is logged under the vault name', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    s.created[0].dispose.mockRejectedValue(new Error('EBUSY'));
    s.entries.detach(1);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.warn).toHaveBeenCalledWith('neuro-vault: vault "v" failed to dispose: EBUSY');
  });

  it('idleTimeoutMs 0 never drops', async () => {
    const s = setup({ idleTimeoutMs: 0 });
    await s.entries.attach(1, '/v', [HARRIER]);
    s.entries.detach(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(IDLE_MS * 1_000);
    expect(s.entries.info()).toHaveLength(1);
    expect(s.created[0].dispose).not.toHaveBeenCalled();
  });

  it('dispose disposes every entry, clears the timers, and is idempotent', async () => {
    const s = setup();
    await s.entries.attach(1, '/v', [HARRIER]);
    await s.entries.attach(2, '/w', [HARRIER]);
    s.entries.detach(2);
    await Promise.all([s.entries.dispose(), s.entries.dispose()]);
    await s.entries.dispose();
    expect(s.created.map((entry) => entry.dispose.mock.calls.length)).toEqual([1, 1]);
    expect(s.entries.info()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
