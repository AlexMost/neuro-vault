import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN_WORK_BOUND,
  deriveTemplate,
  encodeRow,
  padBatch,
  type Encoder,
} from '../../src/modules/semantic/tokenization.js';

/** A tokenizer whose post-processor wraps content in `prefix … suffix`; raw ids are char codes. */
function templated(prefix: number[], suffix: number[]): Encoder {
  return {
    encode: (text, { add_special_tokens }) => {
      const raw = Array.from(text, (c) => c.charCodeAt(0));
      return add_special_tokens ? [...prefix, ...raw, ...suffix] : raw;
    },
  };
}

describe('deriveTemplate', () => {
  it.each([
    ['bos/eos (harrier-270m shape)', [2], [1]],
    ['suffix only (harrier-0.6b shape)', [], [151643]],
    ['start/return (granite-97m shape)', [179934], [179938]],
    ['no special tokens', [], []],
  ])('%s', (_name, prefix, suffix) => {
    expect(deriveTemplate(templated(prefix, suffix))).toEqual({ prefix, suffix });
  });

  it('refuses a tokenizer whose special-token output does not contain the raw run', () => {
    const broken: Encoder = {
      encode: (_t, { add_special_tokens }) => (add_special_tokens ? [7, 8] : [97]),
    };
    expect(() => deriveTemplate(broken)).toThrow(
      'cannot derive the special-token template: [7, 8] does not contain [97]',
    );
  });
});

const bosEos = { prefix: [2], suffix: [1] };

describe('encodeRow', () => {
  const encoder = templated([2], [1]);

  it('wraps short content in the template unchanged', () => {
    expect(
      encodeRow({ prefix: '', content: 'ab', template: bosEos, maxTokens: 8, encoder }),
    ).toEqual([2, 97, 98, 1]);
  });

  it('keeps the end-of-sequence token when it truncates (the EOS regression)', () => {
    const row = encodeRow({
      prefix: '',
      content: 'abcdefghijklmnop',
      template: bosEos,
      maxTokens: 8,
      encoder,
    });
    expect(row).toHaveLength(8);
    expect(row).toEqual([2, 97, 98, 99, 100, 101, 102, 1]);
    // "special tokens, then truncate" would have produced [2, 97, …, 103] — no 1 at the end.
  });

  it('cuts the content, never the query prefix', () => {
    const row = encodeRow({
      prefix: 'Q:',
      content: 'abcdefghij',
      template: bosEos,
      maxTokens: 6,
      encoder,
    });
    expect(row).toEqual([2, 81, 58, 97, 98, 1]);
  });

  it('ends with the real suffix even when content contains the suffix id at the cut', () => {
    const tricky: Encoder = {
      encode: (text, { add_special_tokens }) => {
        const raw = text === 'a' ? [97] : [5, 5, 5, 5, 5, 1, 5, 5, 5];
        return add_special_tokens ? [2, ...raw, 1] : raw;
      },
    };
    const row = encodeRow({
      prefix: '',
      content: 'note',
      template: bosEos,
      maxTokens: 8,
      encoder: tricky,
    });
    expect(row).toEqual([2, 5, 5, 5, 5, 5, 1, 1]);
    const shorter = encodeRow({
      prefix: '',
      content: 'a',
      template: bosEos,
      maxTokens: 8,
      encoder: tricky,
    });
    const { ids, mask } = padBatch([shorter, row], 0, 'right');
    expect(mask[1]).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(mask[0]).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
    expect(ids[1][mask[1].lastIndexOf(1)]).toBe(1);
    expect(ids[1][7]).toBe(1);
  });

  it('bounds tokenizer work on a huge input before tokenising', () => {
    let seen = 0;
    const counting: Encoder = {
      encode: (text, opts) => {
        seen = Math.max(seen, text.length);
        return templated([2], [1]).encode(text, opts);
      },
    };
    encodeRow({
      prefix: '',
      content: 'x'.repeat(5_000_000),
      template: bosEos,
      maxTokens: 512,
      encoder: counting,
    });
    expect(seen).toBe(512 * CHARS_PER_TOKEN_WORK_BOUND);
  });

  it('refuses a window that leaves no room for content', () => {
    expect(() =>
      encodeRow({ prefix: '', content: 'a', template: bosEos, maxTokens: 2, encoder }),
    ).toThrow(/no room for content/);
  });
});

describe('padBatch', () => {
  it('pads on the right with the pad id and masks the pads', () => {
    expect(
      padBatch(
        [
          [2, 9, 1],
          [2, 1],
        ],
        0,
        'right',
      ),
    ).toEqual({
      ids: [
        [2, 9, 1],
        [2, 1, 0],
      ],
      mask: [
        [1, 1, 1],
        [1, 1, 0],
      ],
    });
  });

  it('pads on the left when the tokenizer declares it', () => {
    expect(
      padBatch(
        [
          [2, 9, 1],
          [2, 1],
        ],
        0,
        'left',
      ),
    ).toEqual({
      ids: [
        [2, 9, 1],
        [0, 2, 1],
      ],
      mask: [
        [1, 1, 1],
        [0, 1, 1],
      ],
    });
  });

  it('marks a suffix that equals the pad id as real (harrier-0.6b)', () => {
    expect(padBatch([[7, 151643], [151643]], 151643, 'right').mask).toEqual([
      [1, 1],
      [1, 0],
    ]);
  });
});
