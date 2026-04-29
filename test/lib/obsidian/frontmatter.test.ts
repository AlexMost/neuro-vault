import { describe, expect, it, vi } from 'vitest';

import { splitFrontmatter } from '../../../src/lib/obsidian/frontmatter.js';

describe('splitFrontmatter', () => {
  it('returns null frontmatter and full content when no delimiters', () => {
    expect(splitFrontmatter('# Title\nbody\n')).toEqual({
      frontmatter: null,
      content: '# Title\nbody\n',
    });
  });

  it('returns null frontmatter and full content when input is empty', () => {
    expect(splitFrontmatter('')).toEqual({ frontmatter: null, content: '' });
  });

  it('parses simple key/value frontmatter', () => {
    const raw = '---\ntype: project\nstatus: active\n---\n\n## Body\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: { type: 'project', status: 'active' },
      content: '\n## Body\n',
    });
  });

  it('parses nested arrays in frontmatter', () => {
    const raw = '---\ntags:\n  - ai\n  - mcp\n---\nBody\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: { tags: ['ai', 'mcp'] },
      content: 'Body\n',
    });
  });

  it('handles closing fence followed by EOF (no body)', () => {
    const raw = '---\ntitle: x\n---';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: { title: 'x' },
      content: '',
    });
  });

  it('handles trailing whitespace on closing fence', () => {
    const raw = '---\nfoo: 1\n---  \nbody\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: { foo: 1 },
      content: 'body\n',
    });
  });

  it('returns empty-object frontmatter for empty YAML body', () => {
    const raw = '---\n---\n# Body\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: {},
      content: '# Body\n',
    });
  });

  it('returns null + raw content for malformed YAML', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const raw = '---\nfoo: : bad\n  : nope\n---\nbody\n';
      const result = splitFrontmatter(raw);
      expect(result.frontmatter).toBeNull();
      expect(result.content).toBe(raw);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('returns null + raw content when YAML parses to a scalar/array (not an object)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const raw = '---\n- a\n- b\n---\nbody\n';
      const result = splitFrontmatter(raw);
      expect(result.frontmatter).toBeNull();
      expect(result.content).toBe(raw);
    } finally {
      warn.mockRestore();
    }
  });

  it('handles CRLF line endings', () => {
    const raw = '---\r\ntitle: x\r\n---\r\nbody\r\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: { title: 'x' },
      content: 'body\r\n',
    });
  });

  it('does not treat a non-leading "---" as frontmatter', () => {
    const raw = 'preamble\n---\ntitle: x\n---\nbody\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: null,
      content: raw,
    });
  });
});
