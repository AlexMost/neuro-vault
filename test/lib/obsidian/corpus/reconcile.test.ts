import { mkdtemp, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  reconcileCorpus,
  type ReconcileDeps,
  type ReconcileOptions,
} from '../../../../src/lib/obsidian/corpus/reconcile.js';
import { acquireCorpusLock } from '../../../../src/lib/obsidian/corpus/reconcile-lock.js';
import { formatIdentity } from '../../../../src/lib/obsidian/corpus/identity.js';
import { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { buildEmbedInputs } from '../../../../src/lib/obsidian/corpus/embed-text.js';
import { TEST_DIMS, TEST_IDENTITY } from '../../../_identity.js';

function vectorFor(text: string): number[] {
  const vector = new Array<number>(TEST_DIMS).fill(0);
  for (let i = 0; i < text.length; i += 1) {
    vector[i % TEST_DIMS] = Math.fround((vector[i % TEST_DIMS] ?? 0) + text.charCodeAt(i) / 1000);
  }
  return vector;
}

/** Deterministic fake document embedder: each vector is a checkable function of its text. */
function fakeEmbedDocuments() {
  return vi.fn(async (texts: string[]) => texts.map(vectorFor));
}

/** In-memory vault: path -> { content, mtime, size }. */
function fakeVault(files: Record<string, string>) {
  const state = new Map(
    Object.entries(files).map(([p, content]) => [p, { content, mtime: 1, size: content.length }]),
  );
  const entry = (p: string) => {
    const found = state.get(p);
    if (!found) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return found;
  };
  return {
    state,
    scan: async () => [...state.keys()].sort(),
    stat: async (p: string) => {
      const { mtime, size } = entry(p);
      return { mtime, size };
    },
    readNote: vi.fn(async (p: string) => ({ ...entry(p) })),
    edit(p: string, content: string) {
      state.set(p, { content, mtime: 2, size: content.length });
    },
    touch(p: string) {
      const current = entry(p);
      state.set(p, { ...current, mtime: current.mtime + 1 });
    },
    move(from: string, to: string) {
      const current = entry(from);
      state.delete(from);
      state.set(to, current);
    },
    add(p: string, content: string) {
      state.set(p, { content, mtime: 1, size: content.length });
    },
  };
}

const body = (marker: string) => `# ${marker}\n${'x'.repeat(300)}\n`;

async function harness(files: Record<string, string>, extra: Partial<ReconcileDeps> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-'));
  const vault = fakeVault(files);
  const embed = fakeEmbedDocuments();
  const store = new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
  const warn = vi.fn();
  const run = (opts: ReconcileOptions = {}) =>
    reconcileCorpus(
      {
        vaultRoot: root,
        scan: vault.scan,
        stat: vault.stat,
        readNote: vault.readNote,
        embedDocuments: embed,
        identity: TEST_IDENTITY,
        store,
        warn,
        ...extra,
      },
      opts,
    );
  return { root, vault, embed, store, warn, run };
}

describe('reconcileCorpus', () => {
  it('embeds every in-scope note on the first run', async () => {
    const { run, store } = await harness({ 'A.md': body('A'), 'Dir/B.md': body('B') });

    const summary = await run();

    expect(summary).toMatchObject({ total: 2, embedded: 2, reused: 0, deleted: 0, failed: 0 });
    expect([...(await store.listShards()).keys()].sort()).toEqual(['A.md', 'Dir/B.md']);
  });

  it('embeds a note’s text and its blocks in one call, in order', async () => {
    const note = `# Top\n${'a'.repeat(250)}\n\n## Inner\n${'b'.repeat(250)}\n`;
    const { run, embed } = await harness({ 'A.md': note });
    await run();
    expect(embed).toHaveBeenCalledTimes(1);
    const inputs = buildEmbedInputs('A.md', note);
    expect(embed.mock.calls[0][0]).toEqual([
      ...(inputs.note === null ? [] : [inputs.note]),
      ...inputs.blocks.map((b) => b.embedText),
    ]);
    expect(inputs.blocks.length).toBeGreaterThan(0);
  });

  it('a failed call fails only that note and keeps its previous shard', async () => {
    const { run, vault, store, embed } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    const before = await store.readShard('A.md');
    vault.edit('A.md', body('A2'));
    vault.edit('B.md', body('B2'));
    embed.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes('A2'))) throw new Error('batch failed');
      return texts.map(vectorFor);
    });
    const summary = await run();
    expect(summary).toMatchObject({ embedded: 1, failed: 1 });
    expect(await store.readShard('A.md')).toEqual(before);
  });

  it('embeds nothing on a second run over an untouched vault', async () => {
    const { run, embed, vault } = await harness({ 'A.md': body('A') });
    await run();
    embed.mockClear();
    vault.readNote.mockClear();

    expect(await run()).toMatchObject({ total: 1, embedded: 0, reused: 1, deleted: 0 });
    expect(embed).not.toHaveBeenCalled();
    // The mtime+size pre-check must answer without opening the note.
    expect(vault.readNote).not.toHaveBeenCalled();
  });

  it('does not re-embed a touched but unmodified note', async () => {
    const { run, embed, vault } = await harness({ 'A.md': body('A') });
    await run();
    vault.touch('A.md');
    embed.mockClear();

    expect(await run()).toMatchObject({ reused: 1, embedded: 0 });
    expect(embed).not.toHaveBeenCalled();
  });

  it('updates the shard metadata of a touched but unmodified note', async () => {
    const { run, vault, store } = await harness({ 'A.md': body('A') });
    await run();
    vault.touch('A.md');
    await run();

    const shard = (await store.readShard('A.md'))!;
    expect(shard.mtime).toBe(vault.state.get('A.md')!.mtime);
  });

  it('re-embeds an edited note', async () => {
    const { run, embed, vault, store } = await harness({ 'A.md': body('A') });
    await run();
    const before = (await store.readShard('A.md'))!.embedding;
    vault.edit('A.md', body('A EDITED'));
    embed.mockClear();

    expect(await run()).toMatchObject({ embedded: 1, reused: 0 });
    expect((await store.readShard('A.md'))!.embedding).not.toBe(before);
  });

  it('records a note below the size gate without a note-level vector', async () => {
    const { run, store } = await harness({ 'Short.md': '# S\ntiny\n' });
    await run();

    const shard = (await store.readShard('Short.md'))!;
    expect(shard.embedding).toBeNull();
    expect(shard.blocks).toEqual([]);
    expect(shard.content_hash).toEqual(expect.any(String));
  });

  it('does not re-read a gated note on the next run', async () => {
    const { run, vault } = await harness({ 'Short.md': '# S\ntiny\n' });
    await run();
    vault.readNote.mockClear();

    expect(await run()).toMatchObject({ reused: 1, embedded: 0 });
    expect(vault.readNote).not.toHaveBeenCalled();
  });

  it('deletes the shard of a removed note', async () => {
    const { run, vault, store } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    vault.state.delete('B.md');

    expect(await run()).toMatchObject({ deleted: 1, total: 1 });
    expect([...(await store.listShards()).keys()]).toEqual(['A.md']);
  });

  it('drops a note that left scope and picks up one that entered it', async () => {
    const { run, vault, store } = await harness({ 'A.md': body('A') });
    await run();
    vault.state.delete('A.md');
    vault.add('C.md', body('C'));
    await run();

    expect([...(await store.listShards()).keys()]).toEqual(['C.md']);
  });

  it('does not rebuild when only membership changes', async () => {
    const { run, vault, store, embed } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    const manifestBefore = await store.readManifest();
    const keptBefore = (await store.readShard('A.md'))!;
    // An exclusion change is a membership change, not a vector change: B leaves
    // scope, C enters it, and A must not be touched or re-embedded.
    vault.state.delete('B.md');
    vault.add('C.md', body('C'));
    embed.mockClear();

    const summary = await run();

    expect(summary).toMatchObject({ total: 2, embedded: 1, reused: 1, deleted: 1 });
    expect(await store.readShard('A.md')).toEqual(keptBefore);
    expect(await store.readManifest()).toEqual(manifestBefore);
  });

  it('is idempotent across repeated runs', async () => {
    const { run } = await harness({ 'A.md': body('A'), 'Dir/B.md': body('B') });
    await run();
    await run();

    expect(await run()).toMatchObject({ total: 2, embedded: 0, reused: 2, deleted: 0, failed: 0 });
  });

  it('rebuilds everything when the manifest is incompatible', async () => {
    const { run, store, embed } = await harness({ 'A.md': body('A') });
    await run();
    await store.writeManifest({
      ...TEST_IDENTITY,
      model_key: 'other',
      model_id: 'other/other',
      created: '2026-01-01T00:00:00.000Z',
    });
    embed.mockClear();

    expect(await run()).toMatchObject({ embedded: 1, reused: 0 });
    expect(embed).toHaveBeenCalled();
  });

  it('names a legacy bge-micro-v2 corpus when it rebuilds it', async () => {
    const { run, root } = await harness({ 'A.md': body('A') });
    await run();
    await writeFile(
      path.join(root, '.neuro-vault/corpus/bge-micro-v2/manifest.json'),
      JSON.stringify({
        embed_version: 1,
        model_key: 'bge-micro-v2',
        model_id: 'TaylorAI/bge-micro-v2',
        dims: 384,
        strategy: 'sc-parity-v1',
        created: 'x',
      }),
    );
    const rebuilds: string[] = [];
    const summary = await run({ onRebuild: ({ stored }) => rebuilds.push(formatIdentity(stored)) });
    expect(rebuilds).toEqual(['bge-micro-v2 (embed_version 1)']);
    expect(summary.embedded).toBe(1);
  });

  it('re-embeds a renamed note and removes its old shard', async () => {
    const { run, vault, store, embed } = await harness({ 'A.md': body('A') });
    await run();
    const before = (await store.readShard('A.md'))!;
    vault.move('A.md', 'Dir/A.md');
    embed.mockClear();

    const summary = await run();

    expect(summary).toMatchObject({ renamed: 1, deleted: 0, embedded: 0 });
    expect(await store.readShard('A.md')).toBeNull();
    const after = (await store.readShard('Dir/A.md'))!;
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.embedding).not.toBe(before.embedding);
    expect(embed).toHaveBeenCalled();
  });

  it('gives two notes with identical content two distinct vectors', async () => {
    const shared = body('SAME');
    const { run, store } = await harness({ 'A.md': shared, 'Dir/A.md': shared });
    await run();

    const a = (await store.readShard('A.md'))!;
    const b = (await store.readShard('Dir/A.md'))!;
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.embedding).not.toBe(b.embedding);
  });

  it('reaches the same corpus incrementally as from scratch', async () => {
    const files = { 'A.md': body('A'), 'Dir/B.md': body('B'), 'C.md': body('C') };
    const incremental = await harness(files);
    await incremental.run();
    incremental.vault.edit('A.md', body('A v2'));
    await incremental.run();
    incremental.vault.move('Dir/B.md', 'Moved/B.md');
    await incremental.run();
    incremental.vault.state.delete('C.md');
    incremental.vault.add('D.md', body('D'));
    await incremental.run();

    const scratch = await harness({
      'A.md': body('A v2'),
      'Moved/B.md': body('B'),
      'D.md': body('D'),
    });
    await scratch.run();

    const normalize = async (h: Awaited<ReturnType<typeof harness>>) =>
      [...(await h.store.listShards()).entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, shard]) => [p, { ...shard, mtime: 0, size: 0 }]);

    expect(await normalize(incremental)).toEqual(await normalize(scratch));
  });

  it('reports progress in notes against the in-scope total', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-progress-'));
    const vault = fakeVault({ 'A.md': body('A'), 'B.md': body('B'), 'C.md': body('C') });
    const seen: Array<{ indexed: number; total: number }> = [];

    await reconcileCorpus(
      {
        vaultRoot: root,
        scan: vault.scan,
        stat: vault.stat,
        readNote: vault.readNote,
        embedDocuments: fakeEmbedDocuments(),
        identity: TEST_IDENTITY,
        store: new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS }),
      },
      { onProgress: (p) => seen.push({ ...p }) },
    );

    expect(seen.at(-1)).toEqual({ indexed: 3, total: 3 });
    expect(seen.map((p) => p.indexed)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.total === 3)).toBe(true);
  });

  it('records a failing note and keeps going', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-fail-'));
    const vault = fakeVault({ 'A.md': body('A'), 'Bad.md': body('Bad'), 'C.md': body('C') });
    const embed = vi.fn(async (texts: string[]) => {
      if (texts.some((t) => t.includes('Bad'))) throw new Error('model exploded');
      return texts.map(() => new Array<number>(TEST_DIMS).fill(0.1));
    });
    const store = new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
    const warn = vi.fn();

    const summary = await reconcileCorpus({
      vaultRoot: root,
      scan: vault.scan,
      stat: vault.stat,
      readNote: vault.readNote,
      embedDocuments: embed,
      identity: TEST_IDENTITY,
      store,
      warn,
    });

    expect(summary).toMatchObject({ total: 3, embedded: 2, failed: 1 });
    expect([...(await store.listShards()).keys()].sort()).toEqual(['A.md', 'C.md']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves the previous shard intact when a re-embed fails', async () => {
    const { run, store, vault, root } = await harness({ 'A.md': body('A') });
    await run();
    const before = (await store.readShard('A.md'))!;
    vault.edit('A.md', body('A v2'));

    const summary = await reconcileCorpus({
      vaultRoot: root,
      scan: vault.scan,
      stat: vault.stat,
      readNote: vault.readNote,
      embedDocuments: vi.fn(async () => {
        throw new Error('nope');
      }),
      identity: TEST_IDENTITY,
      store,
      warn: vi.fn(),
    });

    expect(summary).toMatchObject({ total: 1, failed: 1, embedded: 0 });
    expect(await store.readShard('A.md')).toEqual(before);
  });

  it('keeps the old shard when the re-embed of a renamed note fails', async () => {
    const { run, store, vault, root } = await harness({ 'A.md': body('A') });
    await run();
    const before = (await store.readShard('A.md'))!;
    vault.move('A.md', 'Dir/A.md');

    const summary = await reconcileCorpus({
      vaultRoot: root,
      scan: vault.scan,
      stat: vault.stat,
      readNote: vault.readNote,
      embedDocuments: vi.fn(async () => {
        throw new Error('model exploded');
      }),
      identity: TEST_IDENTITY,
      store,
      warn: vi.fn(),
    });

    expect(summary).toMatchObject({ failed: 1, renamed: 0, deleted: 0 });
    expect(await store.readShard('A.md')).toEqual(before);
    expect(await store.readShard('Dir/A.md')).toBeNull();
  });

  it('contains a throwing onProgress callback', async () => {
    const { run, root, vault, store, warn } = await harness({
      'A.md': body('A'),
      'B.md': body('B'),
    });
    await run();
    vault.state.delete('B.md');

    const summary = await reconcileCorpus(
      {
        vaultRoot: root,
        scan: vault.scan,
        stat: vault.stat,
        readNote: vault.readNote,
        embedDocuments: fakeEmbedDocuments(),
        identity: TEST_IDENTITY,
        store,
        warn,
      },
      {
        onProgress: () => {
          throw new Error('renderer exploded');
        },
      },
    );

    // The run still completes: the summary is returned and the orphan is swept.
    expect(summary).toMatchObject({ total: 1, reused: 1, deleted: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onProgress'));
  });

  it('appends the corpus entry to the vault gitignore once', async () => {
    const { root, run } = await harness({ 'A.md': body('A') });
    await writeFile(path.join(root, '.gitignore'), '.obsidian/\n', 'utf8');

    await run();
    await run();

    const { readFile } = await import('node:fs/promises');
    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    expect(
      gitignore.split('\n').filter((line) => line.trim() === '.neuro-vault/corpus/'),
    ).toHaveLength(1);
    expect(gitignore).toContain('.obsidian/');
  });

  it('leaves a corpus of another vault untouched', async () => {
    const first = await harness({ 'A.md': body('A') });
    const second = await harness({ 'B.md': body('B') });
    await first.run();
    await second.run();

    expect([...(await first.store.listShards()).keys()]).toEqual(['A.md']);
    expect([...(await second.store.listShards()).keys()]).toEqual(['B.md']);
  });

  it('re-embeds a note whose shard is corrupt', async () => {
    const { root, run, store, embed } = await harness({ 'A.md': body('A') });
    await run();
    const shardFile = path.join(
      root,
      '.neuro-vault/corpus/bge-micro-v2/notes',
      CorpusStore.shardFileName('A.md'),
    );
    await mkdir(path.dirname(shardFile), { recursive: true });
    await writeFile(shardFile, '{ not json', 'utf8');
    embed.mockClear();

    expect(await run()).toMatchObject({ embedded: 1, failed: 0 });
    expect((await store.readShard('A.md'))!.path).toBe('A.md');
  });

  // A pass kicked off just as the client hung up must not run its setup — the
  // manifest write, the full scan and the full shard listing are seconds of
  // disk work on a large corpus, and they all precede the per-note loop.
  it('does no work at all when the signal is already aborted', async () => {
    const { run, store, vault, embed } = await harness({ 'A.md': body('A') });
    const ensureManifest = vi.spyOn(store, 'ensureManifest');
    const listShards = vi.spyOn(store, 'listShards');

    const summary = await run({ signal: AbortSignal.abort() });

    expect(summary).toEqual({
      total: 0,
      embedded: 0,
      reused: 0,
      renamed: 0,
      deleted: 0,
      failed: 0,
    });
    expect(ensureManifest).not.toHaveBeenCalled();
    expect(listShards).not.toHaveBeenCalled();
    expect(vault.readNote).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
  });

  it('stops at the next note boundary when aborted mid-run', async () => {
    const { run, embed, store } = await harness({
      'A.md': body('A'),
      'B.md': body('B'),
      'C.md': body('C'),
    });
    const controller = new AbortController();
    // Abort while the very first note is being embedded, so the loop has
    // exactly one boundary to notice it at.
    embed.mockImplementationOnce(async (texts: string[]) => {
      controller.abort();
      return texts.map(() => new Array<number>(TEST_DIMS).fill(0));
    });

    const summary = await run({ signal: controller.signal });

    expect(summary.total).toBe(3);
    expect(summary.embedded).toBe(1);
    expect([...(await store.listShards()).keys()]).toEqual(['A.md']);
  });

  it('leaves the orphan sweep for the next pass when aborted', async () => {
    const { run, vault, embed, store } = await harness({
      'A.md': body('A'),
      'Gone.md': body('Gone'),
    });
    await run();
    vault.state.delete('Gone.md');
    vault.edit('A.md', body('A edited'));

    const controller = new AbortController();
    embed.mockImplementationOnce(async (texts: string[]) => {
      controller.abort();
      return texts.map(() => new Array<number>(TEST_DIMS).fill(0));
    });
    const summary = await run({ signal: controller.signal });

    expect(summary.deleted).toBe(0);
    // The shard survives because the sweep never ran, not because deleting it
    // failed — so the next unaborted pass still collects it.
    expect((await store.listShards()).has('Gone.md')).toBe(true);
    expect((await run()).deleted).toBe(1);
  });

  it('reports the stored identity it replaces, once, before any note', async () => {
    const { run, store } = await harness({ 'A.md': body('A') });
    await run();
    await store.writeManifest({
      ...TEST_IDENTITY,
      model_key: 'other',
      created: '2026-01-01T00:00:00.000Z',
    });
    const events: string[] = [];
    await run({
      onRebuild: ({ stored, active }) => events.push(`${stored?.model_key} -> ${active.model_key}`),
      onProgress: () => events.push('progress'),
    });
    expect(events[0]).toBe('other -> bge-micro-v2');
    expect(events.filter((e) => e.includes('->'))).toHaveLength(1);
  });

  it('does not report a rebuild for a matching or a fresh corpus', async () => {
    const { run } = await harness({ 'A.md': body('A') });
    const onRebuild = vi.fn();
    await run({ onRebuild });
    await run({ onRebuild });
    expect(onRebuild).not.toHaveBeenCalled();
  });

  it('a throwing onRebuild is contained', async () => {
    const { run, store, warn } = await harness({ 'A.md': body('A') });
    await run();
    await store.writeManifest({ ...TEST_IDENTITY, model_key: 'other', created: 'x' });
    const summary = await run({
      onRebuild: () => {
        throw new Error('boom');
      },
    });
    expect(summary.embedded).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onRebuild callback threw'));
  });

  it('does not report a stale manifest that had no shards, but still writes the active one', async () => {
    const { run, store } = await harness({ 'A.md': body('A') });
    await store.writeManifest({ ...TEST_IDENTITY, model_key: 'other', created: 'x' });
    const onRebuild = vi.fn();
    await run({ onRebuild });
    expect(onRebuild).not.toHaveBeenCalled();
    expect((await store.readManifest())?.model_key).toBe(TEST_IDENTITY.model_key);
  });
});

const EMPTY_SUMMARY = { total: 0, embedded: 0, reused: 0, renamed: 0, deleted: 0, failed: 0 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('reconcileCorpus across processes', () => {
  it('migrates under the lock, before reading the manifest, and releases last', async () => {
    const calls: string[] = [];
    const { store, run } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async () => {
          calls.push('acquire');
          return {
            release: async () => {
              calls.push('release');
            },
          };
        },
        migrateLegacy: async () => {
          calls.push('migrate');
        },
      },
    );
    const readManifest = store.readManifest.bind(store);
    vi.spyOn(store, 'readManifest').mockImplementation(async () => {
      calls.push('manifest');
      return readManifest();
    });
    await run();
    expect(calls).toEqual(['acquire', 'migrate', 'manifest', 'release']);
  });

  it('reuses a single-corpus layout after moving it into the model directory', async () => {
    const { root, run, embed, store } = await harness({ 'A.md': body('A'), 'B.md': body('B') });
    await run();
    const corpus = path.join(root, '.neuro-vault/corpus');
    const modelDir = path.join(corpus, TEST_IDENTITY.model_key);
    await rename(path.join(modelDir, 'notes'), path.join(corpus, 'notes'));
    await rename(path.join(modelDir, 'manifest.json'), path.join(corpus, 'manifest.json'));
    embed.mockClear();

    expect(await run()).toMatchObject({ total: 2, embedded: 0, reused: 2, deleted: 0, failed: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect((await readdir(corpus)).sort()).toEqual([TEST_IDENTITY.model_key]);
    expect([...(await store.listShards()).keys()].sort()).toEqual(['A.md', 'B.md']);
  });

  it('releases the lock when the pass throws', async () => {
    const { root, run } = await harness(
      { 'A.md': body('A') },
      {
        scan: async () => {
          throw new Error('scan failed');
        },
      },
    );
    await expect(run()).rejects.toThrow('scan failed');
    await expect(stat(path.join(root, '.neuro-vault/corpus/reconcile.lock'))).rejects.toMatchObject(
      {
        code: 'ENOENT',
      },
    );
  });

  it('returns the empty summary when aborted while waiting for the lock', async () => {
    const controller = new AbortController();
    const { run, embed } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async ({ signal, onWait }) => {
          onWait?.({ holderPid: 4242, holderHost: null });
          controller.abort();
          signal?.throwIfAborted();
          throw new Error('unreachable');
        },
      },
    );
    expect(await run({ signal: controller.signal })).toEqual(EMPTY_SUMMARY);
    expect(embed).not.toHaveBeenCalled();
  });

  it('reports the wait, and survives an onLockWait callback that throws', async () => {
    const { run, warn } = await harness(
      { 'A.md': body('A') },
      {
        acquireLock: async ({ onWait }) => {
          onWait?.({ holderPid: 4242, holderHost: null });
          return { release: async () => {} };
        },
      },
    );
    const onLockWait = vi.fn(() => {
      throw new Error('caller bug');
    });
    expect(await run({ onLockWait })).toMatchObject({ embedded: 1, failed: 0 });
    expect(onLockWait).toHaveBeenCalledWith({ holderPid: 4242, holderHost: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onLockWait callback threw'));
  });

  /**
   * Two passes over one temp vault, as two processes would run them: distinct
   * pids, the real lock file. The holder's embed is gated until the other pass
   * has seen the lock held, so the test cannot pass by one finishing first.
   */
  async function twoPasses(
    files: Record<string, string>,
    prepare?: (root: string) => Promise<void>,
  ) {
    const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-'));
    await prepare?.(root);
    const vault = fakeVault(files);
    const gate = deferred();
    const embed = vi.fn(async (texts: string[]) => {
      await gate.promise;
      return texts.map(vectorFor);
    });
    const waits: number[] = [];
    const rebuilds: number[] = [];
    const corpusRoot = path.join(root, '.neuro-vault/corpus');
    const pass = (pid: number) =>
      reconcileCorpus(
        {
          vaultRoot: root,
          scan: vault.scan,
          stat: vault.stat,
          readNote: vault.readNote,
          embedDocuments: embed,
          identity: TEST_IDENTITY,
          store: new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS }),
          warn: vi.fn(),
          acquireLock: (opts) =>
            acquireCorpusLock(
              corpusRoot,
              {
                pid,
                isAlive: () => true,
                sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
              },
              opts,
            ),
        },
        {
          onLockWait: () => {
            waits.push(pid);
            gate.resolve();
          },
          onRebuild: () => {
            rebuilds.push(pid);
          },
        },
      );
    const results = await Promise.all([pass(1001), pass(1002)]);
    return { results, embed, waits, rebuilds };
  }

  it('serialises two passes over one vault: the second reuses what the first embedded', async () => {
    const { results, embed, waits } = await twoPasses({
      'A.md': body('A'),
      'B.md': body('B'),
      'C.md': body('C'),
    });
    expect(waits).toHaveLength(1);
    expect(results.map((r) => r.embedded).sort()).toEqual([0, 3]);
    expect(results.map((r) => r.reused).sort()).toEqual([0, 3]);
    expect(embed).toHaveBeenCalledTimes(3); // one call per note, across both passes
  });

  it('a pass that waited on a rebuild reads the new manifest and discards nothing', async () => {
    const { results, rebuilds, waits } = await twoPasses({ 'A.md': body('A') }, async (root) => {
      // A corpus of this model at another embed_version, with a shard to lose.
      const stale = new CorpusStore(root, { modelKey: TEST_IDENTITY.model_key, dims: TEST_DIMS });
      await stale.writeManifest({
        ...TEST_IDENTITY,
        embed_version: TEST_IDENTITY.embed_version + 1,
        created: 'x',
      });
      await stale.writeShard({
        path: 'A.md',
        content_hash: 'old',
        mtime: 0,
        size: 0,
        embedding: null,
        blocks: [],
      });
    });
    expect(waits).toHaveLength(1);
    expect(rebuilds).toHaveLength(1); // the holder rebuilt; the waiter found it compatible
    expect(results.map((r) => r.embedded).sort()).toEqual([0, 1]);
  });
});
