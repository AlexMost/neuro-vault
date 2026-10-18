import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FsVaultReader } from '../../../../src/lib/obsidian/vault-reader.js';
import { LexicalIndex } from '../../../../src/lib/obsidian/lexical/lexical-index.js';
import { FIXTURE_PATHS, writeFixtureVault } from './_fixture-vault.js';

let vaultRoot: string;

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lexical-index-'));
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

async function write(rel: string, content: string) {
  const full = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

function makeIndex() {
  return new LexicalIndex({ vaultRoot, reader: new FsVaultReader({ vaultRoot }) });
}

const searchOpts = { noteCap: 10, perNoteCap: 3, getBacklinkCount: () => 0 };

describe('LexicalIndex', () => {
  it('finds matches across title, heading, and body', async () => {
    await write('Пошук.md', '');
    await write('other.md', '# пошук\n\nтіло без збігу.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['Пошук.md', 'other.md']);
  });

  it('skips frontmatter (body matching starts after it) but keeps line numbers file-relative', async () => {
    await write('fm.md', '---\ntype: task\n---\n\nтут пошук.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(1);
    expect(notes[0].matches[0].lines).toEqual([5, 5]);
  });

  it('does not match frontmatter content', async () => {
    await write('fm-only.md', '---\ntitle: пошук\n---\n\nінший текст.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(notes).toHaveLength(0);
  });

  it('sees edits on the next call (mtime cache invalidation)', async () => {
    await write('n.md', 'старий текст.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['гібридний'], ...searchOpts })).notes).toHaveLength(0);
    // ensure a distinct mtime even on coarse filesystems
    await new Promise((r) => globalThis.setTimeout(r, 20));
    await write('n.md', 'тут гібридний тест.\n');
    const { notes } = await idx.search({ queries: ['гібридний'], ...searchOpts });
    expect(notes.map((n) => n.path)).toEqual(['n.md']);
  });

  it('drops deleted notes', async () => {
    await write('gone.md', 'пошук тут.\n');
    const idx = makeIndex();
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(1);
    await fs.rm(path.join(vaultRoot, 'gone.md'));
    expect((await idx.search({ queries: ['пошук'], ...searchOpts })).notes).toHaveLength(0);
  });

  it('ordering is reproducible: the same query run twice against an unchanged vault is byte-for-byte identical', async () => {
    await write('Пошук.md', '');
    await write('a пошук.md', 'пошук раз і пошук два.\n');
    await write('b пошук.md', 'один пошук.\n');
    const idx = makeIndex();
    const first = await idx.search({ queries: ['пошук'], ...searchOpts });
    const second = await idx.search({ queries: ['пошук'], ...searchOpts });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('respects the allowed pre-filter set', async () => {
    await write('Tasks/a.md', 'пошук в tasks.\n');
    await write('Archive/b.md', 'пошук в archive.\n');
    const idx = makeIndex();
    const { notes } = await idx.search({
      queries: ['пошук'],
      allowed: new Set(['Tasks/a.md']),
      ...searchOpts,
    });
    expect(notes.map((n) => n.path)).toEqual(['Tasks/a.md']);
  });

  it('exposes totalNotes as the pre-scope vault scan count', async () => {
    await write('Tasks/a.md', 'пошук в tasks.\n');
    await write('Archive/b.md', 'нічого спільного.\n');
    await write('Archive/c.md', 'теж нічого.\n');
    const idx = makeIndex();
    const result = await idx.search({
      queries: ['пошук'],
      allowed: new Set(['Tasks/a.md']),
      ...searchOpts,
    });
    expect(result.totalNotes).toBe(3);
    expect(result.perQueryCounts).toBeDefined();
  });

  it('passes perQueryTokenCounts through from rankNotes', async () => {
    await write('note.md', 'алертів тут.\n');
    const idx = makeIndex();
    const result = await idx.search({
      queries: ['ретеншн алертів'],
      ...searchOpts,
    });
    expect(result.perQueryTokenCounts['ретеншн алертів']).toEqual({
      ретеншн: 0,
      алертів: 1,
    });
  });
});

describe('LexicalIndex shared refresh rule', () => {
  const EDITED = 'Tasks/Backlog.md';

  /** A real reader plus spies on `stat` (per path) and `readFile` (per call). */
  function makeSpiedIndex(extra: { warn?: (m: string) => void } = {}) {
    const statCalls = new Map<string, number>();
    const reads: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    const index = new LexicalIndex({
      vaultRoot,
      reader: new FsVaultReader({ vaultRoot }),
      // The barrier sits AFTER the real stat, so a blocked refresh keeps the
      // mtimes it saw before the test edits a note.
      stat: async (abs) => {
        const rel = path.relative(vaultRoot, abs);
        statCalls.set(rel, (statCalls.get(rel) ?? 0) + 1);
        const s = await fs.stat(abs);
        await gate;
        return s;
      },
      readFile: async (abs) => {
        reads.push(path.relative(vaultRoot, abs));
        return fs.readFile(abs, 'utf8');
      },
      ...extra,
    });
    return {
      index,
      statCalls,
      reads,
      block(): () => void {
        let release!: () => void;
        gate = new Promise<void>((r) => {
          release = r;
        });
        return release;
      },
    };
  }

  async function editBacklog(): Promise<void> {
    const full = path.join(vaultRoot, EDITED);
    await fs.writeFile(full, 'Черга задач: новеслово тут.\n', 'utf8');
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(full, later, later);
  }

  it('a filtered search evicts nothing', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, reads } = makeSpiedIndex();
    const filtered = await index.search({
      queries: ['пошук'],
      allowed: new Set(FIXTURE_PATHS.slice(0, 2)),
      ...searchOpts,
    });
    const readsAfterFirst = reads.length;
    const unfiltered = await index.search({ queries: ['пошук'], ...searchOpts });
    expect(reads.length).toBe(readsAfterFirst);
    expect(filtered.totalNotes).toBe(12);
    expect(unfiltered.totalNotes).toBe(12);
  });

  it('a call during a refresh is served by the next one', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, statCalls, block } = makeSpiedIndex();
    await index.warm();
    statCalls.clear();

    const release = block();
    const a = index.search({ queries: ['новеслово'], ...searchOpts });
    await vi.waitFor(() => expect(statCalls.size).toBe(12));
    await editBacklog();
    const b = index.search({ queries: ['новеслово'], ...searchOpts });
    release();

    // A began before the edit and keeps the state it scanned.
    expect((await a).notes).toHaveLength(0);
    expect((await b).notes.map((n) => n.path)).toEqual([EDITED]);
    expect([...statCalls.values()]).toEqual(new Array(12).fill(2));
  });

  it('concurrent waiters share one follow-up', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, statCalls, block } = makeSpiedIndex();
    await index.warm();
    statCalls.clear();

    const release = block();
    const a = index.search({ queries: ['новеслово'], ...searchOpts });
    await vi.waitFor(() => expect(statCalls.size).toBe(12));
    await editBacklog();
    const b = index.search({ queries: ['новеслово'], ...searchOpts });
    const c = index.search({ queries: ['новеслово'], ...searchOpts });
    release();

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.notes).toHaveLength(0);
    expect(rb.notes.map((n) => n.path)).toEqual([EDITED]);
    expect(rc.notes.map((n) => n.path)).toEqual([EDITED]);
    // A's refresh, then ONE follow-up for B and C: two refreshes, not three.
    expect([...statCalls.values()]).toEqual(new Array(12).fill(2));
  });

  it('warm then info', async () => {
    await writeFixtureVault(vaultRoot);
    const { index } = makeSpiedIndex();
    expect(index.info()).toEqual({ warmed: false, notes: 0 });

    await index.warm();
    const first = index.info();
    expect(first).toMatchObject({ warmed: true, notes: 12, lastRefresh: { parsed: 12 } });
    expect(first.lastRefresh?.at).toBeInstanceOf(Date);
    expect(first.lastRefresh?.ms).toBeGreaterThanOrEqual(0);

    await index.warm();
    expect(index.info().lastRefresh?.parsed).toBe(0);
    expect(index.info().notes).toBe(12);
  });

  it('warm never rejects', async () => {
    const warn = vi.fn();
    const reader = {
      scan: async (): Promise<string[]> => {
        throw new Error('scan exploded');
      },
      readNotes: async () => [],
    };
    const index = new LexicalIndex({ vaultRoot, reader, warn });
    await expect(index.warm()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(index.info()).toEqual({ warmed: false, notes: 0 });
  });
});
