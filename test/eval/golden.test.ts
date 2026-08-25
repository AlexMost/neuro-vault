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
  let vaultRoot: string;
  afterEach(async () => {
    if (vaultRoot) {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  async function makeVault(golden: string, notes: string[]): Promise<void> {
    vaultRoot = await mkdtemp(path.join(tmpdir(), 'eval-golden-'));
    await mkdir(path.dirname(goldenSetPath(vaultRoot)), { recursive: true });
    await writeFile(goldenSetPath(vaultRoot), golden);
    for (const note of notes) {
      await mkdir(path.join(vaultRoot, path.dirname(note)), { recursive: true });
      await writeFile(path.join(vaultRoot, note), '# note\n');
    }
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
});
