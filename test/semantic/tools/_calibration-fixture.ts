import { vi } from 'vitest';

import {
  findBlockNeighbors,
  findDuplicates,
  findNeighbors,
} from '../../../src/modules/semantic/search-engine.js';
import type {
  EmbeddingProvider,
  SearchEngine,
  SmartSource,
} from '../../../src/modules/semantic/types.js';

// 2-D unit vectors: query = [1, 0]; a note whose query-similarity should be
// `s` sits at angle acos(s). A neighbour at seed-angle + acos(t) has
// seed-similarity t and a query-similarity around cos(acos(s) + acos(t)).
const vec = (angle: number): number[] => [Math.cos(angle), Math.sin(angle)];
const angleFor = (sim: number): number => Math.acos(sim);

// Query-similarities for the 8 semantic "band" notes (mirrors the
// 2026-08-10 report's 0.7749–0.7964 band).
const BAND_SIMS = [0.7964, 0.794, 0.791, 0.788, 0.785, 0.781, 0.778, 0.7749];
// Seed↔neighbour similarities for the 4 expansion candidates.
export const NEIGHBOUR_SIMS = [0.9341, 0.9272, 0.9259, 0.9206];

function bandNote(index: number, querySim: number): SmartSource {
  const a = angleFor(querySim);
  return {
    path: `band-${index}.md`,
    embedding: vec(a),
    blocks: [
      {
        key: `band-${index}.md#b0`,
        heading: '#b0',
        lines: [1, 3] as [number, number],
        // Block query-similarity deliberately BELOW the note's, inside
        // (0.35, band): lets Task 3 prove blocks are not thinned by an
        // explicit note threshold.
        embedding: vec(angleFor(querySim - 0.2)),
      },
    ],
  };
}

function neighbourNote(index: number, seedSim: number): SmartSource {
  // Anchored to the top band note's angle; sits "past" the band so its
  // query-similarity (~0.5) clears the deep default 0.35 but always ranks
  // below all 8 band notes — it can only surface via expansion.
  const a = angleFor(BAND_SIMS[0]) + angleFor(seedSim);
  return {
    path: `neighbour-${index}.md`,
    embedding: vec(a),
    blocks: [],
  };
}

export function makeCalibrationFixture(): {
  sources: Map<string, SmartSource>;
  searchEngine: SearchEngine;
  embeddingProvider: EmbeddingProvider;
} {
  const notes = [
    ...BAND_SIMS.map((s, i) => bandNote(i, s)),
    ...NEIGHBOUR_SIMS.map((s, i) => neighbourNote(i, s)),
  ];
  return {
    sources: new Map(notes.map((n) => [n.path, n])),
    searchEngine: { findNeighbors, findBlockNeighbors, findDuplicates },
    embeddingProvider: {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue(vec(0)),
    },
  };
}
