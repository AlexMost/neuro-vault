import { describe, expect, it } from 'vitest';

import { parseNote } from '../../../../src/lib/obsidian/lexical/blocks.js';

describe('parseNote', () => {
  it('derives the title from the filename without .md', () => {
    const parsed = parseNote({ path: 'Tasks/Пошук.md', body: '', lineOffset: 0 });
    expect(parsed.title.raw).toBe('Пошук');
    expect(parsed.title.norm).toBe('пошук');
  });

  it('extracts headings and body blocks with line ranges', () => {
    const body = '# Розділ\n\nПерший абзац.\n\nДругий абзац.\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toEqual([
      expect.objectContaining({ kind: 'heading', raw: 'Розділ', lines: [1, 1] }),
      expect.objectContaining({
        kind: 'body',
        raw: 'Перший абзац.',
        lines: [3, 3],
        heading: 'Розділ',
      }),
      expect.objectContaining({
        kind: 'body',
        raw: 'Другий абзац.',
        lines: [5, 5],
        heading: 'Розділ',
      }),
    ]);
  });

  it('keeps a hard-wrapped paragraph as ONE unit (phrase across linewrap)', () => {
    const body = 'векторний\nпошук у vault\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]!.norm).toContain('векторнии пошук'); // й→и per normalize
    expect(parsed.units[0]!.lines).toEqual([1, 2]);
  });

  it('treats fenced code as body, never heading', () => {
    const body = '```\n# не заголовок\n```\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    expect(parsed.units).toHaveLength(1);
    expect(parsed.units[0]!.kind).toBe('body');
    expect(parsed.units[0]!.raw).toContain('# не заголовок');
  });

  it('collects list items and blockquote paragraphs as body units', () => {
    const body = '- перший пункт\n- другий пункт\n\n> цитата тут\n';
    const parsed = parseNote({ path: 'n.md', body, lineOffset: 0 });
    const texts = parsed.units.map((u) => u.raw);
    expect(texts).toEqual(['перший пункт', 'другий пункт', 'цитата тут']);
  });

  it('shifts line numbers by lineOffset (frontmatter)', () => {
    const parsed = parseNote({ path: 'n.md', body: 'абзац\n', lineOffset: 4 });
    expect(parsed.units[0]!.lines).toEqual([5, 5]);
  });
});
