import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPANSION_FLOOR,
  EFFORT_PROFILES,
  FALLBACK_THRESHOLD,
  LEXICAL_PER_NOTE_CAP,
} from '../../src/modules/semantic/effort-profiles.js';

// Pins the numbers this change moves, so the extraction cannot silently
// retune them. A deliberate retune edits BOTH the profile and this pin.
describe('effort profiles', () => {
  it('keeps the pre-extraction values', () => {
    expect(EFFORT_PROFILES).toEqual({
      quick: {
        semanticPool: 3,
        semanticThreshold: 0.5,
        lexicalNoteCap: 5,
        expansion: false,
        expansionLimit: 0,
        mergedCap: 5,
      },
      deep: {
        semanticPool: 8,
        semanticThreshold: 0.35,
        lexicalNoteCap: 10,
        expansion: true,
        expansionLimit: 3,
        mergedCap: 12,
      },
    });
    expect(LEXICAL_PER_NOTE_CAP).toBe(3);
    expect(FALLBACK_THRESHOLD).toBe(0.3);
    expect(DEFAULT_EXPANSION_FLOOR).toBe(0.35);
  });
});
