import { describe, expect, it } from 'vitest';

import { noteStructure } from '../../src/lib/obsidian/corpus/note-structure.js';
import { resolveSelector } from '../../src/modules/operations/selection.js';

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

  it('any range on an empty note is LINES_OUT_OF_RANGE', () => {
    const r = resolveSelector(noteStructure(''), lines(1, 1), 'e.md');

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('LINES_OUT_OF_RANGE');
    expect(r.message).toMatch(/empty/);
  });
});
