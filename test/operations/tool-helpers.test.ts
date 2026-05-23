import { describe, expect, it } from 'vitest';
import { resolveIdentifier } from '../../src/modules/operations/tool-helpers.js';

describe('resolveIdentifier — path branch auto-promotes to .md', () => {
  it('appends .md when the path has no extension', () => {
    expect(resolveIdentifier(undefined, 'Foo')).toEqual({ kind: 'path', value: 'Foo.md' });
  });

  it('keeps .md unchanged', () => {
    expect(resolveIdentifier(undefined, 'Foo.md')).toEqual({ kind: 'path', value: 'Foo.md' });
  });

  it('handles nested paths', () => {
    expect(resolveIdentifier(undefined, 'Tasks/Foo')).toEqual({
      kind: 'path',
      value: 'Tasks/Foo.md',
    });
  });

  it('keeps foreign extensions unchanged', () => {
    expect(resolveIdentifier(undefined, 'Foo.txt')).toEqual({ kind: 'path', value: 'Foo.txt' });
  });

  it('returns name as-is in the name branch (no .md gymnastics)', () => {
    expect(resolveIdentifier('Foo', undefined)).toEqual({ kind: 'name', value: 'Foo' });
  });
});
