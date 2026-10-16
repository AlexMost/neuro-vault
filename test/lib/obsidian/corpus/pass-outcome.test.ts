import { describe, expect, it } from 'vitest';

import { unusableCorpusReason } from '../../../../src/lib/obsidian/corpus/pass-outcome.js';

describe('unusableCorpusReason', () => {
  it('names the failure when every note failed and nothing can rank', () => {
    expect(unusableCorpusReason(0, { total: 3, failed: 3 })).toBe(
      'indexing produced no usable corpus: 3 of 3 notes failed and the decoded corpus is empty (see the per-note warnings above)',
    );
  });

  it.each([
    ['an empty vault', 0, { total: 0, failed: 0 }],
    ['notes all below the size gate', 0, { total: 2, failed: 0 }],
    ['an incremental pass that lost one note', 5, { total: 6, failed: 1 }],
  ])('is null for %s', (_name, rankable, summary) => {
    expect(unusableCorpusReason(rankable, summary)).toBeNull();
  });
});
