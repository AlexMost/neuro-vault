import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MODEL_PROFILES } from '../../../src/lib/model-profiles.js';
import {
  CorpusNotReadyError,
  type BackendStatus,
} from '../../../src/lib/obsidian/semantic-backend.js';
import { createVaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import { VaultEntries, type IVaultEntriesDeps } from '../../../src/lib/vault-entry/index.js';
import { createVaultEntry } from '../../../src/lib/vault-entry/vault-entry.js';
import { createLocalSemanticBackend } from '../../../src/modules/semantic/backend/local-backend.js';

const PROFILE = 'granite-97m';

/** A note long enough to be embedded (`MIN_CHARS`), distinct per `seed`. */
const noteBody = (seed: string) =>
  `# ${seed}\n\n${`${seed} is a note that talks about one thing in some detail. `.repeat(8)}\n`;

describe('createLocalSemanticBackend', () => {
  let root: string;
  let vault: string;
  let entries: VaultEntries | undefined;
  /** While set, the fake embedder waits for it: a pass cannot finish, so the corpus stays `indexing`. */
  let embedGate: Promise<void> | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nv-local-backend-'));
    vault = path.join(root, 'vault');
    await fs.mkdir(vault);
    await fs.writeFile(path.join(vault, 'a.md'), noteBody('alpha'));
    await fs.writeFile(path.join(vault, 'b.md'), noteBody('beta'));
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
      embedderFor: (key) => async (texts) => {
        await embedGate;
        return texts.map((text) => {
          const v = new Array<number>(MODEL_PROFILES[key].dims).fill(0);
          v[text.includes('alpha') ? 0 : 1] = 1;
          return v;
        });
      },
      idleTimeoutMs: 0,
      // No chokidar: these tests never edit the vault.
      createEntry: (opts) =>
        createVaultEntry({ ...opts, createWatcher: () => ({ close: async () => {} }) }),
      warn: () => {},
      ...extra,
    });
    return entries;
  }

  async function untilReady(read: () => Promise<BackendStatus>): Promise<void> {
    await vi.waitFor(async () => expect(await read()).toEqual({ state: 'ready' }), {
      timeout: 5_000,
      interval: 20,
    });
  }

  it('status is async', async () => {
    const backend = createLocalSemanticBackend({
      entries: makeEntries(),
      connectionId: 0,
      vaultRoot: vault,
      profile: PROFILE,
    });
    const pending = backend.status();
    expect(pending).toBeInstanceOf(Promise);
    expect((await pending).state).toMatch(/^(indexing|ready)$/);
  });

  it('serves reads after the vault is ready', async () => {
    const backend = createLocalSemanticBackend({
      entries: makeEntries(),
      connectionId: 0,
      vaultRoot: vault,
      profile: PROFILE,
    });
    await untilReady(() => backend.status());

    const [hits] = await backend.nearest([{ path: 'a.md' }], { threshold: -1, exclude: ['a.md'] });
    expect(hits).toEqual([{ path: 'b.md', similarity: 0 }]);
    const [blocks] = await backend.nearestBlocks([{ path: 'a.md' }], {
      paths: ['a.md'],
      threshold: 0.5,
    });
    expect(blocks?.every((hit) => hit.path === 'a.md')).toBe(true);
  });

  it('reads are refused with CorpusNotReadyError while indexing', async () => {
    embedGate = new Promise(() => {});
    const backend = createLocalSemanticBackend({
      entries: makeEntries(),
      connectionId: 0,
      vaultRoot: vault,
      profile: PROFILE,
    });
    expect((await backend.status()).state).toBe('indexing');

    const error = await backend.nearest([{ path: 'a.md' }], { threshold: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status.state).toBe('indexing');
  });

  it('attaches once, and reads indexing 0/0 while the attach is in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const all = makeEntries({
      loadScope: async () => {
        await gate;
        return { scope: createVaultScope({}), semantic: true };
      },
    });
    const attach = vi.spyOn(all, 'attach');
    const backend = createLocalSemanticBackend({
      entries: all,
      connectionId: 0,
      vaultRoot: vault,
      profile: PROFILE,
    });

    const first = backend.status();
    expect(await backend.status()).toEqual({ state: 'indexing', indexed: 0, total: 0 });
    release();
    await first;
    await untilReady(() => backend.status());
    await backend.nearest([{ path: 'a.md' }], { threshold: 0 });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(0, vault, [PROFILE]);
  });

  it('a vault that cannot be attached reads unavailable and refuses reads the same way', async () => {
    const backend = createLocalSemanticBackend({
      entries: makeEntries(),
      connectionId: 0,
      vaultRoot: path.join(root, 'missing'),
      profile: PROFILE,
    });

    const status = await backend.status();
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('cannot resolve vault');
    const error = await backend.nearest([{ path: 'a.md' }], { threshold: 0 }).catch((e) => e);
    expect(error).toBeInstanceOf(CorpusNotReadyError);
    expect((error as CorpusNotReadyError).status.state).toBe('unavailable');
  });
});
