import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  MIN_CHARS,
  EMBED_STRATEGY,
  EMBED_VERSION,
} from '../../../../src/lib/obsidian/corpus/types.js';

describe('corpus parity constants', () => {
  it('gates embedding at 200 characters', () => {
    expect(MIN_CHARS).toBe(200);
  });

  it('names the extraction strategy', () => {
    expect(EMBED_STRATEGY).toBe('token-window-v1');
    expect(EMBED_VERSION).toBe(3);
  });

  it('never imports from src/modules', () => {
    const dir = path.resolve('src/lib/obsidian/corpus');
    for (const file of readdirSync(dir)) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      expect(source, `${file} must not import from src/modules`).not.toMatch(/modules\//);
    }
  });
});
