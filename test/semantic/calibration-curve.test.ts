import { describe, expect, it } from 'vitest';

import {
  executeMultiRetrieval,
  executeRetrieval,
} from '../../src/modules/semantic/retrieval-policy.js';
import { makeCalibrationFixture } from './tools/_calibration-fixture.js';

describe('calibration fixture baseline (default inputs)', () => {
  it('deep defaults: 8 seeds, expansion populated, truncated', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q',
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
      `"[{"path":"band-0.md","similarity":0.7964000000000001,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5964}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9341},{"path":"neighbour-1.md","expansion_similarity":0.9272000000000001},{"path":"neighbour-2.md","expansion_similarity":0.9259000000000001}]},{"path":"band-1.md","similarity":0.794,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5940000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9355057819082089},{"path":"neighbour-1.md","expansion_similarity":0.9286753216258283},{"path":"neighbour-2.md","expansion_similarity":0.9273880060283948}]},{"path":"band-2.md","similarity":0.791,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.591}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9372324289905684},{"path":"neighbour-1.md","expansion_similarity":0.9304885401781254},{"path":"neighbour-2.md","expansion_similarity":0.9292170165666037}]},{"path":"band-3.md","similarity":0.788,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5880000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9389257000582385},{"path":"neighbour-1.md","expansion_similarity":0.9322679972504988},{"path":"neighbour-2.md","expansion_similarity":0.9310121963007161}]},{"path":"band-4.md","similarity":0.785,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.585}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9405862188497612},{"path":"neighbour-1.md","expansion_similarity":0.9340143237851524},{"path":"neighbour-2.md","expansion_similarity":0.9327741774684812}]},{"path":"band-5.md","similarity":0.781,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.581}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9427503339492005},{"path":"neighbour-1.md","expansion_similarity":0.93629227279025},{"path":"neighbour-2.md","expansion_similarity":0.9350728956514736}]},{"path":"band-6.md","similarity":0.778,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5780000000000001}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9443367378191877},{"path":"neighbour-1.md","expansion_similarity":0.9379636284376132},{"path":"neighbour-2.md","expansion_similarity":0.9367597519903921}]},{"path":"band-7.md","similarity":0.7749000000000001,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5749}],"related":[{"path":"neighbour-0.md","expansion_similarity":0.9459436474455123},{"path":"neighbour-1.md","expansion_similarity":0.9396579476701251},{"path":"neighbour-2.md","expansion_similarity":0.9384700213604812}]}]"`,
    );
  });

  it('quick defaults: 3 seeds, no expansion', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeRetrieval({
      query: 'q',
      mode: 'quick',
      sources,
      embeddingProvider,
      searchEngine,
    });
    expect(output.results).toHaveLength(3);
    expect(output.results.every((r) => r.related.length === 0)).toBe(true);
    expect(JSON.stringify(output.results)).toMatchInlineSnapshot(
      `"[{"path":"band-0.md","similarity":0.7964000000000001,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5964}],"related":[]},{"path":"band-1.md","similarity":0.794,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.5940000000000001}],"related":[]},{"path":"band-2.md","similarity":0.791,"blocks":[{"heading":"#b0","lines":[1,3],"similarity":0.591}],"related":[]}]"`,
    );
  });

  it('multi-query deep defaults keep the same shape', async () => {
    const { sources, searchEngine, embeddingProvider } = makeCalibrationFixture();
    const output = await executeMultiRetrieval({
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
