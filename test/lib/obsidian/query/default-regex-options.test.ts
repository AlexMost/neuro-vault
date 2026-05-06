import { describe, expect, it } from 'vitest';

import { applyDefaultRegexOptions } from '../../../../src/lib/obsidian/query/default-regex-options.js';

describe('applyDefaultRegexOptions', () => {
  it('injects $options: "i" when $regex has no $options', () => {
    const out = applyDefaultRegexOptions({
      tags: { $regex: '^ai' },
    });
    expect(out).toEqual({
      tags: { $regex: '^ai', $options: 'i' },
    });
  });

  it('leaves explicit $options untouched (case-sensitive opt-out)', () => {
    const out = applyDefaultRegexOptions({
      tags: { $regex: '^ai', $options: '' },
    });
    expect(out).toEqual({
      tags: { $regex: '^ai', $options: '' },
    });
  });

  it('leaves explicit $options untouched (multiline only, no i)', () => {
    const out = applyDefaultRegexOptions({
      tags: { $regex: '^ai', $options: 'm' },
    });
    expect(out).toEqual({
      tags: { $regex: '^ai', $options: 'm' },
    });
  });

  it('leaves explicit $options untouched (already case-insensitive)', () => {
    const out = applyDefaultRegexOptions({
      tags: { $regex: '^ai', $options: 'mi' },
    });
    expect(out).toEqual({
      tags: { $regex: '^ai', $options: 'mi' },
    });
  });

  it('applies the default inside $and / $or / $nor / $not', () => {
    const out = applyDefaultRegexOptions({
      $and: [
        { tags: { $regex: '^ai' } },
        {
          $or: [
            { 'frontmatter.title': { $regex: 'foo' } },
            { 'frontmatter.title': { $regex: 'bar', $options: '' } },
          ],
        },
        { $nor: [{ tags: { $regex: 'draft' } }] },
        { 'frontmatter.tag': { $not: { $regex: 'archive' } } },
      ],
    });
    expect(out).toEqual({
      $and: [
        { tags: { $regex: '^ai', $options: 'i' } },
        {
          $or: [
            { 'frontmatter.title': { $regex: 'foo', $options: 'i' } },
            { 'frontmatter.title': { $regex: 'bar', $options: '' } },
          ],
        },
        { $nor: [{ tags: { $regex: 'draft', $options: 'i' } }] },
        { 'frontmatter.tag': { $not: { $regex: 'archive', $options: 'i' } } },
      ],
    });
  });

  it('returns the input shape unchanged when there is no $regex', () => {
    const input = {
      'frontmatter.status': 'active',
      tags: { $in: ['ai', 'mcp'] },
      backlink_count: { $gte: 5 },
    };
    expect(applyDefaultRegexOptions(input)).toEqual(input);
  });

  it('does not mutate the input filter', () => {
    const input = {
      $and: [{ tags: { $regex: '^ai' } }, { 'frontmatter.x': { $regex: 'y' } }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    applyDefaultRegexOptions(input);
    expect(input).toEqual(snapshot);
  });
});
