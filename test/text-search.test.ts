import { describe, expect, it } from 'vitest';

import { ObsidianCliSearchProvider } from '../src/text-search.js';

describe('ObsidianCliSearchProvider', () => {
  it('isAvailable returns a boolean', async () => {
    const provider = new ObsidianCliSearchProvider();
    const result = await provider.isAvailable();
    expect(typeof result).toBe('boolean');
  });
});
