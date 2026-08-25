import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GoldenSetError, goldenSetPath, loadGoldenSet, parseGoldenSet } from '../../eval/golden.js';

const VALID = `
- id: q001
  query: "release flow"
  lang: en
  source: 2026-W20
  relevant:
    - Reflections/release flow.md
- id: q002
  query: "векторний пошук"
  lang: ua
  relevant:
    - Ideas/embeddings.md
    - Tasks/rag.md
`;

describe('parseGoldenSet', () => {
  it('parses valid entries', () => {
    const entries = parseGoldenSet(VALID);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: 'q001',
      query: 'release flow',
      lang: 'en',
      source: '2026-W20',
      relevant: ['Reflections/release flow.md'],
    });
  });

  it.each([
    ['missing query', '- id: q1\n  lang: en\n  relevant: [a.md]', 'q1'],
    ['unknown lang', '- id: q1\n  query: x\n  lang: fr\n  relevant: [a.md]', 'q1'],
    ['empty relevant', '- id: q1\n  query: x\n  lang: en\n  relevant: []', 'q1'],
    ['missing id', '- query: x\n  lang: en\n  relevant: [a.md]', 'entry 1'],
  ])('rejects %s naming the entry', (_name, yamlText, needle) => {
    expect(() => parseGoldenSet(yamlText)).toThrow(GoldenSetError);
    expect(() => parseGoldenSet(yamlText)).toThrow(needle);
  });

  it('rejects duplicate ids', () => {
    const dup = `${VALID}- id: q001\n  query: y\n  lang: en\n  relevant: [b.md]\n`;
    expect(() => parseGoldenSet(dup)).toThrow(/duplicate.*q001/i);
  });

  it('rejects a non-list document', () => {
    expect(() => parseGoldenSet('foo: bar')).toThrow(GoldenSetError);
  });
});

describe('loadGoldenSet', () => {
  // `tempRoot` is the parent of `vaultRoot` so an escaping `../outside.md`
  // entry has somewhere real to point at.
  let tempRoot: string;
  let vaultRoot: string;
  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  async function makeVault(golden: string, notes: string[]): Promise<void> {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'eval-golden-'));
    vaultRoot = path.join(tempRoot, 'vault');
    await mkdir(vaultRoot, { recursive: true });
    await mkdir(path.dirname(goldenSetPath(vaultRoot)), { recursive: true });
    await writeFile(goldenSetPath(vaultRoot), golden);
    for (const note of notes) {
      await mkdir(path.join(vaultRoot, path.dirname(note)), { recursive: true });
      await writeFile(path.join(vaultRoot, note), '# note\n');
    }
  }

  function oneEntry(relevant: string): string {
    return `- id: q001\n  query: x\n  lang: en\n  relevant:\n    - "${relevant}"\n`;
  }

  it('resolves the fixed conventional path', () => {
    expect(goldenSetPath('/v')).toBe(path.join('/v', '.neuro-vault/eval/golden.yaml'));
  });

  it('passes when every relevant path exists', async () => {
    await makeVault(VALID, ['Reflections/release flow.md', 'Ideas/embeddings.md', 'Tasks/rag.md']);
    await expect(loadGoldenSet(vaultRoot)).resolves.toHaveLength(2);
  });

  it('lists ALL broken entries (id + path) and throws', async () => {
    await makeVault(VALID, ['Reflections/release flow.md']);
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenSetError);
    const message = (err as Error).message;
    expect(message).toContain('q002');
    expect(message).toContain('Ideas/embeddings.md');
    expect(message).toContain('Tasks/rag.md');
  });

  // Each of these passes an `fs.access` check on the joined path yet is absent
  // from the corpus and the lexical index, so `scoreQuery`'s Set lookup could
  // never match it — a permanently unwinnable query. The gate validates
  // membership in the scoped vault listing precisely to catch them.
  it('rejects a case-mismatched path (case-insensitive volumes)', async () => {
    await makeVault(oneEntry('Notes/Foo.md'), ['Notes/foo.md']);
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenSetError);
    expect((err as Error).message).toContain('Notes/Foo.md');
  });

  it('rejects a path escaping the vault root', async () => {
    await makeVault(oneEntry('../outside.md'), ['Notes/foo.md']);
    await writeFile(path.join(tempRoot, 'outside.md'), '# note\n');
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenSetError);
    expect((err as Error).message).toContain('../outside.md');
  });

  it('rejects a note the vault scope excludes', async () => {
    // A dot-segment note exists on disk but is unconditionally invisible to
    // indexing and search, so it can never be ranked.
    await makeVault(oneEntry('.archive/hidden.md'), ['Notes/foo.md', '.archive/hidden.md']);
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoldenSetError);
    expect((err as Error).message).toContain('.archive/hidden.md');
  });

  it('says a broken entry is not in the vault rather than merely missing', async () => {
    await makeVault(oneEntry('Notes/gone.md'), ['Notes/foo.md']);
    const err = await loadGoldenSet(vaultRoot).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not in the vault \(or excluded by scope\)/i);
  });
});
