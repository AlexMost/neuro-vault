import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CorpusStore } from '../../src/lib/obsidian/corpus/shard-store.js';
import { MODEL_DIMS } from '../../src/lib/obsidian/corpus/types.js';
import { encodeVector } from '../../src/lib/obsidian/corpus/vector-codec.js';
import { BackendError, loadSnapshot } from '../../eval/backends.js';

function unitVec(hot: number): number[] {
  const v = new Array<number>(MODEL_DIMS).fill(0);
  v[hot] = 1;
  return v;
}

describe('own backend snapshot', () => {
  let vaultRoot: string;
  afterEach(async () => rm(vaultRoot, { recursive: true, force: true }));

  it('decodes shards into SmartSource entries and skips vectorless notes', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-'));
    const store = new CorpusStore(vaultRoot);
    await store.writeShard({
      path: 'Notes/a.md',
      content_hash: 'h1',
      mtime: 1,
      size: 10,
      embedding: encodeVector(unitVec(0)),
      blocks: [{ key: '#H1', heading: 'H1', lines: [1, 4], embedding: encodeVector(unitVec(1)) }],
    });
    await store.writeShard({
      path: 'Notes/short.md', // below MIN_CHARS at index time → null note vector
      content_hash: 'h2',
      mtime: 2,
      size: 5,
      embedding: null,
      blocks: [],
    });

    const sources = await loadSnapshot('own', vaultRoot);
    expect([...sources.keys()]).toEqual(['Notes/a.md']);
    const a = sources.get('Notes/a.md')!;
    expect(a.embedding[0]).toBe(1);
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({ key: '#H1', heading: 'H1', lines: [1, 4] });
    expect(a.blocks[0].embedding[1]).toBe(1);
  });

  it('fails an empty corpus pointing at the index command', async () => {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-own-empty-'));
    const err = await loadSnapshot('own', vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendError);
    expect((err as Error).message).toContain('neuro-vault-mcp index');
  });
});

describe('sc backend snapshot', () => {
  // The SC loader throws for a missing directory AND for a corpus with no
  // usable notes, so the wrapped `catch` message is the ONLY message a real
  // `sc` failure ever prints. The spec requires it to name the corpus and say
  // how to produce it, so the remedy has to live on this reachable path.
  it('fails a vault without a Smart Connections corpus, naming the corpus and the remedy', async () => {
    const vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-sc-'));
    const err = await loadSnapshot('sc', vaultRoot).catch((e: unknown) => e);
    await rm(vaultRoot, { recursive: true, force: true });
    expect(err).toBeInstanceOf(BackendError);
    const message = (err as Error).message;
    expect(message).toMatch(/smart connections/i);
    expect(message).toContain(path.join(vaultRoot, '.smart-env', 'multi'));
    expect(message).toMatch(/open the vault in Obsidian with Smart Connections installed/i);
  });
});
