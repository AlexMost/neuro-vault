import { describe, expect, it } from 'vitest';

import { deriveTemplate, type Encoder } from '../../src/modules/semantic/tokenization.js';

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
