import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  EMBED_CHAR_BUDGET,
  MAX_TOKENS,
  MIN_CHARS,
  SC_PARITY_STRATEGY,
} from '../../../../src/lib/obsidian/corpus/types.js';

describe('corpus parity constants', () => {
  it('cuts note embed text at max_tokens x 3.7', () => {
    expect(MAX_TOKENS).toBe(512);
    expect(EMBED_CHAR_BUDGET).toBe(1894);
  });

  it('gates embedding at 200 characters', () => {
    expect(MIN_CHARS).toBe(200);
  });

  it('names the extraction strategy', () => {
    expect(SC_PARITY_STRATEGY).toBe('sc-parity-v1');
  });

  it('never imports from src/modules', () => {
    const dir = path.resolve('src/lib/obsidian/corpus');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source, `${file} must not import from src/modules`).not.toMatch(/modules\//);
    }
  });
});
