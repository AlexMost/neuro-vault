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
  vi.restoreAllMocks();
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
    // Stats whose real fs.stat has returned (the mtime a refresh will act on is fixed).
    let statsDone = 0;
    // Two refreshes overlap exactly when one path is being statted by both at once.
    const inFlight = new Map<string, number>();
    let maxInFlightPerPath = 0;
    let gate: Promise<void> = Promise.resolve();
    const index = new LexicalIndex({
      vaultRoot,
      reader: new FsVaultReader({ vaultRoot }),
      // The barrier sits AFTER the real stat, so a blocked refresh keeps the
      // mtimes it saw before the test edits a note.
      stat: async (abs) => {
        const rel = path.relative(vaultRoot, abs);
        statCalls.set(rel, (statCalls.get(rel) ?? 0) + 1);
        const now = (inFlight.get(rel) ?? 0) + 1;
        inFlight.set(rel, now);
        maxInFlightPerPath = Math.max(maxInFlightPerPath, now);
        const s = await fs.stat(abs);
        statsDone++;
        await gate;
        inFlight.set(rel, (inFlight.get(rel) ?? 1) - 1);
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
      statsDone: () => statsDone,
      maxInFlightPerPath: () => maxInFlightPerPath,
      block(): () => void {
        let release!: () => void;
        gate = new Promise<void>((r) => {
          release = r;
        });
        return release;
      },
    };
  }

  async function editNote(rel: string, text: string, offsetMs: number): Promise<void> {
    const full = path.join(vaultRoot, rel);
    await fs.writeFile(full, text, 'utf8');
    const later = new Date(Date.now() + offsetMs);
    await fs.utimes(full, later, later);
  }

  // Lets a (mutant) overlapping refresh reach its stat calls while the barrier is held.
  const settle = (): Promise<void> => new Promise((r) => globalThis.setTimeout(r, 50));

  const editBacklog = (): Promise<void> =>
    editNote(EDITED, 'Черга задач: новеслово тут.\n', 60_000);

  it('dispose during a refresh stops it: no further read, no warning, warm resolves', async () => {
    await writeFixtureVault(vaultRoot);
    const warn = vi.fn();
    const { index, reads, statsDone, block } = makeSpiedIndex({ warn });

    const release = block();
    const warming = index.warm();
    await vi.waitFor(() => expect(statsDone()).toBe(12));
    index.dispose();
    release();

    await expect(warming).resolves.toBeUndefined();
    await settle();
    expect(reads).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(index.info().warmed).toBe(false);
  });

  it('a read returning after dispose parses nothing', async () => {
    await writeFixtureVault(vaultRoot);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reading = 0;
    const index = new LexicalIndex({
      vaultRoot,
      reader: new FsVaultReader({ vaultRoot }),
      readFile: async (abs) => {
        reading++;
        await gate;
        return fs.readFile(abs, 'utf8');
      },
    });

    const warming = index.warm();
    await vi.waitFor(() => expect(reading).toBe(12));
    index.dispose();
    release();

    await expect(warming).resolves.toBeUndefined();
    expect(index.info()).toEqual({ warmed: false, notes: 0 });
  });

  it('a follow-up queued before dispose scans nothing', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, statsDone, block } = makeSpiedIndex();
    const scan = vi.spyOn(FsVaultReader.prototype, 'scan');

    const release = block();
    const first = index.warm();
    await vi.waitFor(() => expect(statsDone()).toBe(12));
    const queued = index.search({ queries: ['пошук'], ...searchOpts });
    const rejected = expect(queued).rejects.toThrow(/disposed/);
    index.dispose();
    release();

    await first;
    await rejected;
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('a scan failing after dispose is not warned about', async () => {
    const warn = vi.fn();
    let fail!: (err: Error) => void;
    const reader = {
      scan: () => new Promise<string[]>((_, reject) => (fail = reject)),
      readNotes: async () => [],
    };
    const index = new LexicalIndex({ vaultRoot, reader, warn });
    const warming = index.warm();
    index.dispose();
    fail(new Error('scan exploded'));
    await expect(warming).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('a search after dispose rejects as disposed', async () => {
    await writeFixtureVault(vaultRoot);
    const { index } = makeSpiedIndex();
    index.dispose();
    await expect(index.search({ queries: ['пошук'], ...searchOpts })).rejects.toThrow(/disposed/);
  });

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
    const { index, statCalls, statsDone, maxInFlightPerPath, block } = makeSpiedIndex();
    await index.warm();
    statCalls.clear();
    const base = statsDone();

    const release = block();
    const a = index.search({ queries: ['новеслово'], ...searchOpts });
    await vi.waitFor(() => expect(statsDone() - base).toBe(12));
    await editBacklog();
    const b = index.search({ queries: ['новеслово'], ...searchOpts });
    await settle();
    release();

    // A began before the edit and keeps the state it scanned.
    expect((await a).notes).toHaveLength(0);
    expect((await b).notes.map((n) => n.path)).toEqual([EDITED]);
    expect([...statCalls.values()]).toEqual(new Array(12).fill(2));
    expect(maxInFlightPerPath()).toBe(1);
  });

  it('concurrent waiters share one follow-up', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, statCalls, statsDone, maxInFlightPerPath, block } = makeSpiedIndex();
    await index.warm();
    statCalls.clear();
    const base = statsDone();

    const release = block();
    const a = index.search({ queries: ['новеслово'], ...searchOpts });
    await vi.waitFor(() => expect(statsDone() - base).toBe(12));
    await editBacklog();
    const b = index.search({ queries: ['новеслово'], ...searchOpts });
    const c = index.search({ queries: ['новеслово'], ...searchOpts });
    await settle();
    release();

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.notes).toHaveLength(0);
    expect(rb.notes.map((n) => n.path)).toEqual([EDITED]);
    expect(rc.notes.map((n) => n.path)).toEqual([EDITED]);
    // A's refresh, then ONE follow-up for B and C: two refreshes, not three.
    expect([...statCalls.values()]).toEqual(new Array(12).fill(2));
    expect(maxInFlightPerPath()).toBe(1);
  });

  it('a call arriving while the follow-up runs is served by a refresh that starts after it', async () => {
    await writeFixtureVault(vaultRoot);
    const { index, statCalls, statsDone, maxInFlightPerPath, block } = makeSpiedIndex();
    await index.warm();
    statCalls.clear();
    const base = statsDone();

    const releaseA = block();
    const a = index.search({ queries: ['новеслово другеслово'], ...searchOpts });
    await vi.waitFor(() => expect(statsDone() - base).toBe(12));
    await editBacklog();
    const b = index.search({ queries: ['новеслово'], ...searchOpts });

    // Hold the follow-up (B's refresh) after its stats, then land a second edit and add C.
    const releaseB = block();
    await settle();
    releaseA();
    await vi.waitFor(() => expect(statsDone() - base).toBe(24));
    await editNote('Ideas/Semantic ideas.md', 'Ідея: другеслово тут.\n', 120_000);
    const c = index.search({ queries: ['другеслово'], ...searchOpts });
    await settle();
    releaseB();

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.notes).toHaveLength(0);
    // B's refresh statted before the second edit: it must not see it.
    expect(rb.notes.map((n) => n.path)).toEqual([EDITED]);
    const rbLater = await index.search({ queries: ['другеслово'], ...searchOpts });
    expect(rbLater.notes.map((n) => n.path)).toEqual(['Ideas/Semantic ideas.md']);
    // C was served by a third refresh that began after C arrived.
    expect(rc.notes.map((n) => n.path)).toEqual(['Ideas/Semantic ideas.md']);
    expect(maxInFlightPerPath()).toBe(1);
  });

  it('queued callers are still served when the refresh they waited on fails', async () => {
    await writeFixtureVault(vaultRoot);
    const real = new FsVaultReader({ vaultRoot });
    let scans = 0;
    let fail!: () => void;
    const failing = new Promise<void>((_, reject) => {
      fail = () => reject(new Error('scan exploded'));
    });
    const reader = {
      readNotes: real.readNotes.bind(real),
      scan: async (): Promise<string[]> => {
        scans++;
        if (scans === 1) await failing;
        return real.scan();
      },
    };
    const index = new LexicalIndex({ vaultRoot, reader });
    const a = index.search({ queries: ['пошук'], ...searchOpts });
    const aOutcome = a.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.waitFor(() => expect(scans).toBe(1));
    const b = index.search({ queries: ['пошук'], ...searchOpts });
    const c = index.search({ queries: ['пошук'], ...searchOpts });
    fail();

    expect(await aOutcome).toBe('rejected');
    const [rb, rc] = await Promise.all([b, c]);
    expect(rb.totalNotes).toBe(12);
    expect(rc.totalNotes).toBe(12);
    expect(scans).toBe(2);
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
