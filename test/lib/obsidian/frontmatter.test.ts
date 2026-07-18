import { describe, expect, it, vi } from 'vitest';

import {
  serializeFrontmatter,
  sliceFrontmatterYaml,
  splitFrontmatter,
} from '../../../src/lib/obsidian/frontmatter.js';
import { splitRawFrontmatter } from '../../../src/lib/obsidian/in-place-edit.js';

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

  // Templater placeholders like `{{date}}` are valid YAML flow syntax that parses
  // to a collection-valued key, which `yaml` reports via `process.emitWarning`.
  // Reading a template note must not spam stderr (once per note on every scan).
  it('does not emit a process warning for template-placeholder frontmatter', () => {
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const raw = '---\ndate: {{date}}\ntitle: Untitled\n---\nbody\n';
      // Parsing still succeeds; only the stderr noise is suppressed.
      expect(splitFrontmatter(raw).content).toBe('body\n');
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  it('does not treat a non-leading "---" as frontmatter', () => {
    const raw = 'preamble\n---\ntitle: x\n---\nbody\n';
    expect(splitFrontmatter(raw)).toEqual({
      frontmatter: null,
      content: raw,
    });
  });
});

describe('sliceFrontmatterYaml', () => {
  // Feeds `sliceFrontmatterYaml` the exact `prefix` shape it consumes in
  // production (from `splitRawFrontmatter`), so the two stay contract-aligned.
  const yamlOf = (raw: string) => sliceFrontmatterYaml(splitRawFrontmatter(raw).prefix);

  it('strips the fence lines and returns the inner YAML', () => {
    expect(yamlOf('---\nstatus: todo\npriority: 2\n---\nbody\n')).toBe(
      'status: todo\npriority: 2\n',
    );
  });

  it('handles CRLF line endings', () => {
    expect(yamlOf('---\r\nstatus: todo\r\n---\r\nbody\r\n')).toBe('status: todo\r\n');
  });

  it('keeps a value that embeds --- (closing fence is the rightmost)', () => {
    expect(yamlOf('---\nrule: "a --- b"\n---\nbody\n')).toBe('rule: "a --- b"\n');
  });

  it('returns empty string for an empty frontmatter block', () => {
    expect(yamlOf('---\n---\nbody\n')).toBe('');
  });
});

describe('serializeFrontmatter', () => {
  it('wraps a simple object in fences with a trailing newline', () => {
    expect(serializeFrontmatter({ type: 'task', status: 'todo' })).toBe(
      '---\ntype: task\nstatus: todo\n---\n',
    );
  });

  it('quotes a wikilink value so the leading [ is not a flow sequence', () => {
    expect(serializeFrontmatter({ project: '[[neuro-vault]]' })).toBe(
      '---\nproject: "[[neuro-vault]]"\n---\n',
    );
  });

  it('keeps an ISO date string as a plain scalar', () => {
    expect(serializeFrontmatter({ created: '2026-06-01' })).toBe('---\ncreated: 2026-06-01\n---\n');
  });

  it('renders a tag array as a block list', () => {
    expect(serializeFrontmatter({ tags: ['mcp', 'dx'] })).toBe(
      '---\ntags:\n  - mcp\n  - dx\n---\n',
    );
  });

  it('renders nested objects', () => {
    expect(serializeFrontmatter({ meta: { a: 1, b: 2 } })).toBe(
      '---\nmeta:\n  a: 1\n  b: 2\n---\n',
    );
  });

  it('round-trips through splitFrontmatter (written == read)', () => {
    const fm = {
      type: 'task',
      status: 'todo',
      project: '[[neuro-vault]]',
      tags: ['mcp', 'dx'],
      priority: 3,
    };
    const { frontmatter, content } = splitFrontmatter(serializeFrontmatter(fm));
    expect(frontmatter).toEqual(fm);
    expect(content).toBe('');
  });

  // Documents the empty-object contract: serializeFrontmatter does NOT special-case
  // `{}` — it emits the raw `yaml.stringify({})` output. Callers must treat an empty
  // object as "no frontmatter" themselves (the create_note tool does exactly this).
  it('emits raw yaml.stringify output for an empty object (callers must not pass {})', () => {
    expect(serializeFrontmatter({})).toBe('---\n{}\n---\n');
  });
});
