import { describe, expect, it } from 'vitest';

import {
  EFFORT_PROFILES,
  LEXICAL_PER_NOTE_CAP,
  lexicalPool,
} from '../../src/modules/semantic/effort-profiles.js';

// Pins the model-independent retrieval knobs, so they cannot silently be
// retuned (the similarity thresholds are model data: see model-profiles). A deliberate retune edits BOTH the profile and this pin.
describe('effort profiles', () => {
  it('keeps the pre-extraction values', () => {
    expect(EFFORT_PROFILES).toEqual({
      quick: {
        semanticPool: 3,
        lexicalNoteCap: 5,
        expansion: false,
        expansionLimit: 0,
        mergedCap: 5,
      },
      deep: {
        semanticPool: 8,
        lexicalNoteCap: 10,
        expansion: true,
        expansionLimit: 3,
        mergedCap: 12,
      },
    });
    expect(LEXICAL_PER_NOTE_CAP).toBe(3);
  });

  it('pools the lexical leg at the merged cap only when it is the sole source', () => {
    expect(lexicalPool('quick', true)).toBe(EFFORT_PROFILES.quick.mergedCap);
    expect(lexicalPool('deep', true)).toBe(EFFORT_PROFILES.deep.mergedCap);
    expect(lexicalPool('quick', false)).toBe(EFFORT_PROFILES.quick.lexicalNoteCap);
    expect(lexicalPool('deep', false)).toBe(EFFORT_PROFILES.deep.lexicalNoteCap);
  });
});
