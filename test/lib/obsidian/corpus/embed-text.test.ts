import { describe, expect, it } from 'vitest';

import { buildEmbedInputs } from '../../../../src/lib/obsidian/corpus/embed-text.js';
import { EMBED_CHAR_BUDGET } from '../../../../src/lib/obsidian/corpus/types.js';

const long = (n: number) => 'x'.repeat(n);

describe('buildEmbedInputs', () => {
  it('builds block embed text from breadcrumbs without the block own heading', () => {
    const content = ['# Top', long(250), '## Inner', long(250)].join('\n');
    const { blocks } = buildEmbedInputs('Folder/Note.md', content);
    const inner = blocks.find((b) => b.key === '#Top#Inner');
    expect(inner?.embedText.split('\n')[0]).toBe('Folder > Note > Top');
    expect(inner?.embedText).toContain('## Inner');
  });

  it('builds note embed text from path breadcrumbs and truncates by characters', () => {
    const { note } = buildEmbedInputs('Folder/Note.md', long(5000));
    expect(note?.startsWith('Folder > Note:\n')).toBe(true);
    expect(note).toHaveLength(EMBED_CHAR_BUDGET);
  });

  it('drops the note-level input below the gate but keeps qualifying blocks', () => {
    const content = ['# Top', long(250)].join('\n');
    const { note } = buildEmbedInputs('N.md', content.slice(0, 150));
    expect(note).toBeNull();
    expect(buildEmbedInputs('N.md', content).blocks.map((b) => b.key)).toContain('#Top');
  });

  it('drops blocks below the gate', () => {
    const { blocks } = buildEmbedInputs('N.md', ['# Top', 'short'].join('\n'));
    expect(blocks).toHaveLength(0);
  });

  it('skips a parent block fully covered by embedded sub-blocks', () => {
    const content = ['# Top', '## A', long(250), '## B', long(250)].join('\n');
    const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
    expect(keys).toEqual(['#Top#A', '#Top#B']);
  });

  it('keeps a parent that holds text of its own', () => {
    const content = ['# Top', long(250), '## A', long(250)].join('\n');
    const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
    expect(keys).toContain('#Top');
  });

  it('keeps a parent whose own uncovered content is fenced "#" lines', () => {
    // A fenced `# ...` line is content, not a heading; excusing it would drop the
    // parent and the fenced lines would land in no embedded block.
    const content = [
      '## Parent',
      '```',
      long(250),
      '',
      '# fake heading inside fence',
      '',
      long(250),
      '```',
    ].join('\n');
    const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
    expect(keys).toContain('##Parent');
  });

  it('drops a parent fully covered by children under an indented heading', () => {
    // The chunker honours an ATX heading indented 1-3 spaces; the coverage gate
    // must not count that heading line as uncovered parent content.
    const content = ['  ## Indented', '### A', long(250), '### B', long(250)].join('\n');
    const keys = buildEmbedInputs('N.md', content).blocks.map((b) => b.key);
    expect(keys).toEqual(['##Indented#A', '##Indented#B']);
  });

  it('is deterministic', () => {
    const content = ['# Top', long(250)].join('\n');
    expect(buildEmbedInputs('A/N.md', content)).toEqual(buildEmbedInputs('A/N.md', content));
  });

  it('changes every embed text when the path changes', () => {
    const content = ['# Top', long(250)].join('\n');
    const before = buildEmbedInputs('A/N.md', content);
    const after = buildEmbedInputs('B/N.md', content);
    expect(after.note).not.toBe(before.note);
    expect(after.blocks[0]?.embedText).not.toBe(before.blocks[0]?.embedText);
  });

  it('only drops the note path .md, not a literal ".md" inside an ancestor heading', () => {
    const content = ['# Migrate config.md', long(250), '## Inner', long(250)].join('\n');
    const { note, blocks } = buildEmbedInputs('Folder/Note.md', content);
    const inner = blocks.find((b) => b.key === '#Migrate config.md#Inner');
    expect(inner?.embedText.split('\n')[0]).toBe('Folder > Note > Migrate config.md');
    expect(note?.startsWith('Folder > Note:\n')).toBe(true);
  });
});
