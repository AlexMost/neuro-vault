import { describe, expect, it } from 'vitest';

import { executeRetrieval } from '../../src/modules/semantic/retrieval-policy.js';
import { makeCalibrationFixture } from './tools/_calibration-fixture.js';

describe('calibration fixture baseline (default inputs)', () => {
  it('deep defaults: 8 seeds, expansion populated, truncated', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(8);
    expect(output.truncated).toBe(true);
    expect(output.results.map((r) => r.path)).toMatchInlineSnapshot(`
      [
        "band-0.md",
        "band-1.md",
        "band-2.md",
        "band-3.md",
        "band-4.md",
        "band-5.md",
        "band-6.md",
        "band-7.md",
      ]
    `);
    expect(output.results.map((r) => r.related.map((n) => n.path))).toMatchInlineSnapshot(`
      [
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
        [
          "neighbour-0.md",
          "neighbour-1.md",
          "neighbour-2.md",
        ],
      ]
    `);
    // Full-precision similarity lock — the byte-for-byte default guarantee.
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot(
      `"[{"path":"band-0.md","similarity":0.7964000000000001,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5964}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9341},{"path":"neighbour-1.md","expansion_similarity":0.9272000000000001},{"path":"neighbour-2.md","expansion_similarity":0.9259000000000001}]},{"path":"band-1.md","similarity":0.794,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5940000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9355057819082089},{"path":"neighbour-1.md","expansion_similarity":0.9286753216258283},{"path":"neighbour-2.md","expansion_similarity":0.9273880060283948}]},{"path":"band-2.md","similarity":0.791,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.591}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9372324289905684},{"path":"neighbour-1.md","expansion_similarity":0.9304885401781254},{"path":"neighbour-2.md","expansion_similarity":0.9292170165666037}]},{"path":"band-3.md","similarity":0.788,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5880000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9389257000582385},{"path":"neighbour-1.md","expansion_similarity":0.9322679972504988},{"path":"neighbour-2.md","expansion_similarity":0.9310121963007161}]},{"path":"band-4.md","similarity":0.785,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.585}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9405862188497612},{"path":"neighbour-1.md","expansion_similarity":0.9340143237851524},{"path":"neighbour-2.md","expansion_similarity":0.9327741774684812}]},{"path":"band-5.md","similarity":0.781,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.581}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9427503339492005},{"path":"neighbour-1.md","expansion_similarity":0.93629227279025},{"path":"neighbour-2.md","expansion_similarity":0.9350728956514736}]},{"path":"band-6.md","similarity":0.778,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5780000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9443367378191877},{"path":"neighbour-1.md","expansion_similarity":0.9379636284376132},{"path":"neighbour-2.md","expansion_similarity":0.9367597519903921}]},{"path":"band-7.md","similarity":0.7749000000000001,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5749}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9459436474455123},{"path":"neighbour-1.md","expansion_similarity":0.9396579476701251},{"path":"neighbour-2.md","expansion_similarity":0.9384700213604812}]}]"`,
    );
  });

  it('quick defaults: 3 seeds, no expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(3);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot(
      `"[{"path":"band-0.md","similarity":0.7964000000000001,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5964}],"related":[]},{"path":"band-1.md","similarity":0.794,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5940000000000001}],"related":[]},{"path":"band-2.md","similarity":0.791,"matched_queries":["q"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.591}],"related":[]}]"`,
    );
  });

  it('multi-query deep defaults keep the same shape', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      queries: ['q1', 'q2'],
      mode: 'deep',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(8);
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot(
      `"[{"path":"band-0.md","similarity":0.7964000000000001,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5964}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9341},{"path":"neighbour-1.md","expansion_similarity":0.9272000000000001},{"path":"neighbour-2.md","expansion_similarity":0.9259000000000001}]},{"path":"band-1.md","similarity":0.794,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5940000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9355057819082089},{"path":"neighbour-1.md","expansion_similarity":0.9286753216258283},{"path":"neighbour-2.md","expansion_similarity":0.9273880060283948}]},{"path":"band-2.md","similarity":0.791,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.591}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9372324289905684},{"path":"neighbour-1.md","expansion_similarity":0.9304885401781254},{"path":"neighbour-2.md","expansion_similarity":0.9292170165666037}]},{"path":"band-3.md","similarity":0.788,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5880000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9389257000582385},{"path":"neighbour-1.md","expansion_similarity":0.9322679972504988},{"path":"neighbour-2.md","expansion_similarity":0.9310121963007161}]},{"path":"band-4.md","similarity":0.785,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.585}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9405862188497612},{"path":"neighbour-1.md","expansion_similarity":0.9340143237851524},{"path":"neighbour-2.md","expansion_similarity":0.9327741774684812}]},{"path":"band-5.md","similarity":0.781,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.581}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9427503339492005},{"path":"neighbour-1.md","expansion_similarity":0.93629227279025},{"path":"neighbour-2.md","expansion_similarity":0.9350728956514736}]},{"path":"band-6.md","similarity":0.778,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5780000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9443367378191877},{"path":"neighbour-1.md","expansion_similarity":0.9379636284376132},{"path":"neighbour-2.md","expansion_similarity":0.9367597519903921}]},{"path":"band-7.md","similarity":0.7749000000000001,"matched_queries":["q1","q2"],"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5749}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9459436474455123},{"path":"neighbour-1.md","expansion_similarity":0.9396579476701251},{"path":"neighbour-2.md","expansion_similarity":0.9384700213604812}]}]"`,
    );
  });
});

describe('split thresholds on the calibration fixture', () => {
  it('expansionFloor 0.93 floors expansion at 0.93; 0.99 empties expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const at93 = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      expansionFloor: 0.93,
      sources,
      embeddingProvider,
      searchEngine,
    });
    const survivors93 = new Set(at93.results.flatMap((r) => r.related.map((n) => n.path)));
    expect(survivors93.size).toBeGreaterThan(0);
    for (const r of at93.results) {
      for (const n of r.related) expect(n.expansion_similarity).toBeGreaterThanOrEqual(0.93);
    }

    const at99 = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      expansionFloor: 0.99,
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(at99.results.every((r) => r.related.length === 0)).toBe(true);
  });

  it('an explicit threshold no longer shapes expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    // 0.6: below the band (all 8 seeds survive), far above the old
    // accidental expansion coupling's bite point.
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      threshold: 0.6,
      sources,
      embeddingProvider,
      searchEngine,
    });
    const defaults = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results.map((r) => r.related)).toEqual(defaults.results.map((r) => r.related));
  });

  it('explicit threshold 0.99 yields honest zero seeds (deep)', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      threshold: 0.99,
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toEqual([]);
    expect(output.per_query_fallback).toEqual({ q: false });
  });

  it('an in-band explicit threshold filters partially', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      threshold: 0.787,
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThan(8);
    for (const r of output.results) expect(r.similarity).toBeGreaterThanOrEqual(0.787);
  });

  it('an explicit note threshold does not thin block evidence', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    // Band blocks sit ~0.2 below their note (inside (0.35, band)); with the
    // old coupling a 0.787 note threshold silently dropped them to backfill.
    const output = await executeRetrieval({
      queries: ['q'],
      mode: 'deep',
      threshold: 0.787,
      sources,
      embeddingProvider,
      searchEngine,
    });
    for (const r of output.results) {
      expect(r.blocks.length).toBeGreaterThan(0);
      expect(r.blocks[0]!.similarity).toBeGreaterThan(0.35);
    }
  });
});
