import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { reconcileCorpus } from '../../../../src/lib/obsidian/corpus/reconcile.js';
import { CorpusStore } from '../../../../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_DIMS } from '../../../../src/lib/obsidian/corpus/types.js';

/** Deterministic fake embedder: the vector is a checkable function of its input text. */
function fakeEmbed() {
  return vi.fn(async (text: string) => {
    const vector = new Array<number>(MODEL_DIMS).fill(0);
    for (let i = 0; i < text.length; i += 1) {
      vector[i % MODEL_DIMS] = Math.fround(
        (vector[i % MODEL_DIMS] ?? 0) + text.charCodeAt(i) / 1000,
      );
    }
    return vector;
  });
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

async function harness(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), 'nv-reconcile-'));
  const vault = fakeVault(files);
  const embed = fakeEmbed();
  const store = new CorpusStore(root);
  const warn = vi.fn();
  const run = () =>
    reconcileCorpus({
      vaultRoot: root,
      scan: vault.scan,
      stat: vault.stat,
      readNote: vault.readNote,
      embed,
      store,
      warn,
    });
  return { root, vault, embed, store, warn, run };
}

describe('reconcileCorpus', () => {
  it('embeds every in-scope note on the first run', async () => {
    const { run, store } = await harness({ 'A.md': body('A'), 'Dir/B.md': body('B') });

    const summary = await run();

    expect(summary).toMatchObject({ total: 2, embedded: 2, reused: 0, deleted: 0, failed: 0 });
    expect([...(await store.listShards()).keys()].sort()).toEqual(['A.md', 'Dir/B.md']);
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
      embed_version: 1,
      model_key: 'other',
      dims: MODEL_DIMS,
      strategy: 'sc-parity-v1',
      created: '2026-01-01T00:00:00.000Z',
    });
    embed.mockClear();

    expect(await run()).toMatchObject({ embedded: 1, reused: 0 });
    expect(embed).toHaveBeenCalled();
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
        embed: fakeEmbed(),
        store: new CorpusStore(root),
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
    const embed = vi.fn(async (text: string) => {
      if (text.includes('Bad')) throw new Error('model exploded');
      return new Array<number>(MODEL_DIMS).fill(0.1);
    });
    const store = new CorpusStore(root);
    const warn = vi.fn();

    const summary = await reconcileCorpus({
      vaultRoot: root,
      scan: vault.scan,
      stat: vault.stat,
      readNote: vault.readNote,
      embed,
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
      embed: vi.fn(async () => {
        throw new Error('nope');
      }),
      store,
      warn: vi.fn(),
    });

    expect(summary).toMatchObject({ total: 1, failed: 1, embedded: 0 });
    expect(await store.readShard('A.md')).toEqual(before);
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
      '.neuro-vault/corpus/notes',
      CorpusStore.shardFileName('A.md'),
    );
    await mkdir(path.dirname(shardFile), { recursive: true });
    await writeFile(shardFile, '{ not json', 'utf8');
    embed.mockClear();

    expect(await run()).toMatchObject({ embedded: 1, failed: 0 });
    expect((await store.readShard('A.md'))!.path).toBe('A.md');
  });
});
