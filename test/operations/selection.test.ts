import { describe, expect, it } from 'vitest';

import { noteStructure } from '../../src/lib/obsidian/corpus/note-structure.js';
import { normalizeHeadingName, resolveSelector } from '../../src/modules/operations/selection.js';

/** A 40-line note: lines 1-4 frontmatter, then `line 5` .. `line 40`. */
function fortyLines(): string {
  const body = Array.from({ length: 36 }, (_, i) => `line ${i + 5}`);
  return ['---', 'a: 1', 'b: 2', '---', ...body].join('\n') + '\n';
}

describe('resolveSelector: lines', () => {
  const structure = noteStructure(fortyLines());
  const lines = (a: number, b: number) => ({
    kind: 'lines' as const,
    lines: [a, b] as [number, number],
  });

  it('clips a range overlapping the frontmatter to the first body line', () => {
    expect(resolveSelector(structure, lines(2, 9), 'n.md')).toStrictEqual({
      ok: true,
      span: [5, 9],
    });
  });

  it('clips a range past the end to the last line', () => {
    expect(resolveSelector(structure, lines(30, 45), 'n.md')).toStrictEqual({
      ok: true,
      span: [30, 40],
    });
  });

  it('resolves a one-line range', () => {
    expect(resolveSelector(structure, lines(7, 7), 'n.md')).toStrictEqual({
      ok: true,
      span: [7, 7],
    });
  });

  it('a range wholly inside the frontmatter is LINES_OUT_OF_RANGE pointing at a frontmatter read', () => {
    const r = resolveSelector(structure, lines(1, 3), 'n.md');

    expect(r).toStrictEqual({
      ok: false,
      code: 'LINES_OUT_OF_RANGE',
      message:
        "lines 1–3 of n.md lie in the frontmatter (body: lines 5–40); read the frontmatter with content: 'frontmatter', or a range inside the body",
    });
  });

  it('a range past the end is LINES_OUT_OF_RANGE naming the range and the body span', () => {
    const r = resolveSelector(structure, lines(50, 60), 'n.md');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('LINES_OUT_OF_RANGE');
    expect(r.message).toMatch(/lines 50–60/);
    expect(r.message).toMatch(/body: lines 5–40/);
    expect(r.message).toMatch(/retry with a range inside the body/);
  });

  it('any range on a frontmatter-only note is LINES_OUT_OF_RANGE pointing at a frontmatter read', () => {
    const r = resolveSelector(noteStructure('---\na: 1\n---\n'), lines(1, 1), 'n.md');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('LINES_OUT_OF_RANGE');
    expect(r.message).toMatch(/no body/);
    expect(r.message).toMatch(/content: 'frontmatter'/);
  });

  it('a one-line range names its line in the singular', () => {
    expect(resolveSelector(structure, lines(4, 4), 'n.md')).toStrictEqual({
      ok: false,
      code: 'LINES_OUT_OF_RANGE',
      message:
        "line 4 of n.md lies in the frontmatter (body: lines 5–40); read the frontmatter with content: 'frontmatter', or a range inside the body",
    });
    expect(resolveSelector(structure, lines(50, 50), 'n.md')).toMatchObject({
      message: expect.stringMatching(/^line 50 of n\.md lies past the end/) as string,
    });
    expect(resolveSelector(noteStructure(''), lines(1, 1), 'e.md')).toMatchObject({
      message: expect.stringMatching(/^line 1 of e\.md is out of range/) as string,
    });
  });

  it('any range on an empty note is LINES_OUT_OF_RANGE', () => {
    const r = resolveSelector(noteStructure(''), lines(1, 1), 'e.md');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('LINES_OUT_OF_RANGE');
    expect(r.message).toMatch(/empty/);
  });
});

describe('normalizeHeadingName', () => {
  it.each([
    ['## **Open** questions', 'open questions'],
    ['###### Deep', 'deep'],
    ['####### Seven', '####### seven'],
    ['#tag', '#tag'],
    ['[[notes/alpha|Alpha]]', 'alpha'],
    ['[[target]]', 'target'],
    ['see [the docs](https://example.com/x)', 'see the docs'],
    ['`code` __bold__ _it_ *em* **strong**', 'code bold it em strong'],
    ['  Spread   \t out  ', 'spread out'],
    ['🚀 Launch: v2!', '🚀 launch: v2!'],
    ['Нотатки Зустрічі', 'нотатки зустрічі'],
    ['Notes[2]', 'notes[2]'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeHeadingName(input)).toBe(expected);
  });

  it.each([
    ['straße', 'STRASSE'],
    ['οδοσ', 'ΟΔΟΣ'],
    ['Cafe\u0301 notes', 'Caf\u00e9 notes'],
  ])('%j and %j compare equal (full case folding, NFC)', (a, b) => {
    expect(normalizeHeadingName(a)).toBe(normalizeHeadingName(b));
  });
});

describe('resolveSelector: heading', () => {
  const heading = (name: string) => ({ kind: 'heading' as const, heading: name });

  it('resolves an exact name to its whole block, with the name and level', () => {
    const s = noteStructure('# Top\n## Progress\na\n### Week 1\nb\n## Next\n');

    expect(resolveSelector(s, heading('Progress'), 'n.md')).toStrictEqual({
      ok: true,
      span: [2, 5],
      heading: 'Progress',
      level: 2,
    });
  });

  it('falls back to a normalized comparison that hits exactly one block', () => {
    const s = noteStructure('## **Open** questions\nq\n');

    expect(resolveSelector(s, heading('open questions'), 'n.md')).toStrictEqual({
      ok: true,
      span: [1, 2],
      heading: '**Open** questions',
      level: 2,
    });
  });

  it('prefers an exact match over normalized ones', () => {
    const s = noteStructure('## Plan\na\n## plan\nb\n');

    expect(resolveSelector(s, heading('plan'), 'n.md')).toMatchObject({ ok: true, span: [3, 4] });
  });

  it('a normalized fallback that hits two blocks is AMBIGUOUS_MATCH with both', () => {
    const s = noteStructure('## Plan\na\n## plan\nb\n');

    expect(resolveSelector(s, heading('PLAN'), 'n.md')).toStrictEqual({
      ok: false,
      code: 'AMBIGUOUS_MATCH',
      message:
        'heading "PLAN" matches 2 heading blocks of n.md (lines 1–2, lines 3–4); read the one you want with { path, lines: [start, end] } from matches',
      matches: [
        { heading: 'Plan', level: 2, lines: [1, 2] },
        { heading: 'plan', level: 2, lines: [3, 4] },
      ],
    });
  });

  it('a name matching no block is HEADING_NOT_FOUND pointing at the outline', () => {
    const s = noteStructure('## 2026-01-15 standup\nx\n');

    expect(resolveSelector(s, heading('2026-01'), 'n.md')).toStrictEqual({
      ok: false,
      code: 'HEADING_NOT_FOUND',
      message:
        'no heading block of n.md is named "2026-01", exactly or ignoring case and markup; retry with a heading name from outline',
    });
  });

  it('a frontmatter-only note is HEADING_NOT_FOUND pointing at a frontmatter read', () => {
    const r = resolveSelector(noteStructure('---\na: 1\n---\n'), heading('Notes'), 'n.md');

    expect(r).toStrictEqual({
      ok: false,
      code: 'HEADING_NOT_FOUND',
      message:
        'no heading block of n.md is named "Notes": the note has frontmatter (lines 1–3) and no body; read the frontmatter with content: \'frontmatter\'',
    });
  });

  it('an empty note is HEADING_NOT_FOUND saying the note is empty', () => {
    const r = resolveSelector(noteStructure(''), heading('Notes'), 'e.md');

    expect(r).toStrictEqual({
      ok: false,
      code: 'HEADING_NOT_FOUND',
      message:
        'no heading block of e.md is named "Notes": the note is empty and has nothing to read',
    });
  });

  it('a note without headings is HEADING_NOT_FOUND pointing at a whole or lines read', () => {
    const r = resolveSelector(noteStructure('just text\n'), heading('Notes'), 'n.md');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('HEADING_NOT_FOUND');
    expect(r.message).toMatch(/has no headings/);
    expect(r.message).toMatch(/\{ path, lines/);
  });
});
