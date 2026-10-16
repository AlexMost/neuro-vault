import { describe, expect, it } from 'vitest';

import {
  defaultModelCacheDir,
  type TokenizerHandle,
} from '../../src/modules/semantic/local-model-loader.js';
import { MODEL_KEYS, resolveModelProfile } from '../../src/lib/model-profiles.js';
import { deriveTemplate, encodeRow } from '../../src/modules/semantic/tokenization.js';

// Downloads each profile's tokenizer (not its weights) at the pinned revision.
// Off by default; the `profile-tokenizers` CI job turns it on.
const enabled = process.env.NEURO_VAULT_HF_TESTS === '1';

const EXPECTED: Record<string, { prefix: number[]; suffix: number[]; side: string }> = {
  'granite-97m': { prefix: [179934], suffix: [179938], side: 'right' },
  'harrier-270m': { prefix: [2], suffix: [1], side: 'right' },
  'harrier-0.6b': { prefix: [], suffix: [151643], side: 'right' },
};

describe.skipIf(!enabled)('profile tokenizers at their pinned revisions', () => {
  it('covers every registered profile', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...MODEL_KEYS].sort());
  });

  for (const key of MODEL_KEYS) {
    it(`${key}: derived template, padding side, truncation keeps the suffix`, async () => {
      // Imported here so a skipped run never loads the library.
      const { AutoTokenizer, env } = await import('@huggingface/transformers');
      env.cacheDir = defaultModelCacheDir();
      const profile = resolveModelProfile(key);
      const tokenizer = (await AutoTokenizer.from_pretrained(profile.repo, {
        revision: profile.revision,
      })) as unknown as TokenizerHandle;

      const template = deriveTemplate(tokenizer);
      expect(template).toEqual({ prefix: EXPECTED[key].prefix, suffix: EXPECTED[key].suffix });
      expect(tokenizer.padding_side).toBe(EXPECTED[key].side);

      const row = encodeRow({
        prefix: '',
        content: 'векторний пошук and semantic retrieval over notes. '.repeat(300),
        template,
        maxTokens: profile.maxTokens,
        encoder: tokenizer,
      });
      expect(row).toHaveLength(profile.maxTokens);
      expect(row.slice(row.length - template.suffix.length)).toEqual(template.suffix);
    }, 180_000);
  }
});
