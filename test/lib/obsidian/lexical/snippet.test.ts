import { describe, expect, it } from 'vitest';

import { makeSnippet } from '../../../../src/lib/obsidian/lexical/snippet.js';
import { normalizeWithMap } from '../../../../src/lib/obsidian/lexical/normalize.js';

describe('makeSnippet', () => {
  it('returns the whole text when it fits the window', () => {
    const raw = 'короткий рядок';
    const { norm, map } = normalizeWithMap(raw);
    expect(makeSnippet(raw, map, norm.indexOf('рядок'), 'рядок'.length)).toBe('короткий рядок');
  });

  it('windows long text around the match with ellipses', () => {
    const raw = `${'а'.repeat(300)} пошук ${'б'.repeat(300)}`;
    const { norm, map } = normalizeWithMap(raw);
    const snippet = makeSnippet(raw, map, norm.indexOf('пошук'), 'пошук'.length);
    expect(snippet).toContain('пошук');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect([...snippet].length).toBeLessThanOrEqual(160);
  });

  it('does not split surrogate pairs / emoji at window edges', () => {
    const raw = `${'🐍'.repeat(120)} пошук ${'🐍'.repeat(120)}`;
    const { norm, map } = normalizeWithMap(raw);
    const snippet = makeSnippet(raw, map, norm.indexOf('пошук'), 'пошук'.length);
    // well-formed: re-encoding round-trips only when no lone surrogates exist
    expect(snippet).toBe(globalThis.Buffer.from(snippet, 'utf8').toString('utf8'));
  });
});
