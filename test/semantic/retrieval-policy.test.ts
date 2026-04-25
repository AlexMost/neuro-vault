import { describe, expect, it, vi } from 'vitest';

import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchResult,
  SmartSource,
} from '../../src/types.js';
import { executeRetrieval } from '../../src/modules/semantic/retrieval-policy.js';

function makeSource(path: string, embedding: number[] = [1, 0]): SmartSource {
  return {
    path,
    embedding,
    blocks: [{ key: `${path}#block`, heading: '#block', lines: [1, 3], embedding }],
  };
}

function makeSearchResult(path: string, similarity: number): SearchResult {
  return { path, similarity };
}

function makeBlockResult(path: string, similarity: number): BlockSearchResult {
  return { path, heading: '#block', lines: [1, 3], similarity };
}

function makeSources(entries: Array<[string, number[]]>): Map<string, SmartSource> {
  return new Map(entries.map(([path, emb]) => [path, makeSource(path, emb)]));
}

function makeEmbeddingProvider(vector: number[] = [1, 0]): EmbeddingProvider {
  return {
    initialize: vi.fn(),
    embed: vi.fn().mockResolvedValue(vector),
  };
}

function makeSearchEngine(
  overrides: Partial<{
    findNeighbors: SearchEngine['findNeighbors'];
    findBlockNeighbors: SearchEngine['findBlockNeighbors'];
    findDuplicates: SearchEngine['findDuplicates'];
  }> = {},
): SearchEngine {
  return {
    findNeighbors: vi.fn().mockReturnValue([]),
    findBlockNeighbors: vi.fn().mockReturnValue([]),
    findDuplicates: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe('executeRetrieval', () => {
  const sources = makeSources([
    ['note-a.md', [1, 0]],
    ['note-b.md', [0.8, 0.2]],
    ['note-c.md', [0, 1]],
  ]);

  describe('quick mode defaults', () => {
    it('calls findNeighbors with threshold 0.5 and limit 3', async () => {
      const searchEngine = makeSearchEngine();
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.5, limit: 3 }),
      );
    });

    it('calls findBlockNeighbors in quick mode when vector results exist', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
      });
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findBlockNeighbors).toHaveBeenCalled();
    });

    it('does not call findBlockNeighbors in quick mode when no vector results', async () => {
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([]),
      });
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findBlockNeighbors).not.toHaveBeenCalled();
    });
  });

  describe('deep mode defaults', () => {
    it('calls findNeighbors with threshold 0.35 and limit 8', async () => {
      const searchEngine = makeSearchEngine();
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.35, limit: 8 }),
      );
    });

    it('calls findBlockNeighbors in deep mode', async () => {
      const searchEngine = makeSearchEngine();
      const embeddingProvider = makeEmbeddingProvider();

      await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findBlockNeighbors).toHaveBeenCalled();
    });
  });

  describe('fallback to lower threshold', () => {
    it('retries with threshold 0.3 when initial search returns empty', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce([]) // first call returns nothing
          .mockReturnValueOnce([makeSearchResult('note-a.md', 0.35)]), // fallback returns something
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(2);
      const secondCall = (searchEngine.findNeighbors as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall[0]).toMatchObject({ threshold: 0.3 });
      expect(output.results).toHaveLength(1);
    });

    it('does not retry if initial threshold is already <= 0.3', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([]),
      });

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        threshold: 0.3,
        sources,
        embeddingProvider,
        searchEngine,
      });

      // Only 1 call — no fallback retry since threshold is already at limit
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(1);
    });
  });

  describe('expansion', () => {
    it('uses top results embeddings to find additional neighbors', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const initialResults = [
        makeSearchResult('note-a.md', 0.9),
        makeSearchResult('note-b.md', 0.7),
      ];
      const expansionResults = [makeSearchResult('note-c.md', 0.65)];

      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce(initialResults) // first query search
          .mockReturnValueOnce(expansionResults), // expansion search
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 1,
        sources,
        embeddingProvider,
        searchEngine,
      });

      // Should have been called at least twice (initial + expansion)
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(
        1 + // initial query
          1, // expansion for top 1 result
      );
      // note-c.md should be in the merged results
      expect(output.results.map((r) => r.path)).toContain('note-c.md');
    });

    it('deduplicates expansion results with initial results', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const initialResults = [makeSearchResult('note-a.md', 0.9)];
      const expansionResults = [
        makeSearchResult('note-a.md', 0.6), // already in results
        makeSearchResult('note-b.md', 0.55),
      ];

      const searchEngine = makeSearchEngine({
        findNeighbors: vi
          .fn()
          .mockReturnValueOnce(initialResults)
          .mockReturnValueOnce(expansionResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        expansion: true,
        expansionLimit: 1,
        sources,
        embeddingProvider,
        searchEngine,
      });

      const noteAPaths = output.results.filter((r) => r.path === 'note-a.md');
      expect(noteAPaths).toHaveLength(1);
      expect(noteAPaths[0]!.similarity).toBe(0.9); // keeps higher similarity
    });

    it('does not expand when expansion is false', async () => {
      const embeddingProvider = makeEmbeddingProvider([1, 0]);
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.9)]),
      });

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        expansion: false,
        sources,
        embeddingProvider,
        searchEngine,
      });

      // Only 1 call — no expansion
      expect(searchEngine.findNeighbors).toHaveBeenCalledTimes(1);
    });
  });

  describe('threshold override', () => {
    it('passes custom threshold to findNeighbors instead of mode default', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine();

      await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        threshold: 0.7,
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.7 }),
      );
    });

    it('uses deep mode defaults when no threshold override is given', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine();

      await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(searchEngine.findNeighbors).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 0.35 }),
      );
    });
  });

  describe('block results', () => {
    it('returns blockResults only in deep mode', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const blockResults = [makeBlockResult('note-a.md', 0.8)];
      const searchEngine = makeSearchEngine({
        findBlockNeighbors: vi.fn().mockReturnValue(blockResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.blockResults).toBeDefined();
      expect(output.blockResults).toEqual(blockResults);
    });

    it('returns blockResults in quick mode scoped to matched notes', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const blockResults = [makeBlockResult('note-a.md', 0.75)];
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([makeSearchResult('note-a.md', 0.8)]),
        findBlockNeighbors: vi.fn().mockReturnValue(blockResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.blockResults).toBeDefined();
      expect(output.blockResults).toEqual(blockResults);
      // block search uses threshold 0 and limit 5 (scoping is via source filter)
      const blockCall = (searchEngine.findBlockNeighbors as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(blockCall[0]).toMatchObject({ threshold: 0, limit: 5 });
    });

    it('does not return blockResults in quick mode when no vector results', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue([]),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.blockResults).toBeUndefined();
    });
  });

  describe('final limit', () => {
    it('slices results to mode limit', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const manyResults = Array.from({ length: 10 }, (_, i) =>
        makeSearchResult(`note-${i}.md`, 0.9 - i * 0.05),
      );
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue(manyResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'quick', // limit = 3
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(3);
    });

    it('applies deep mode limit of 8', async () => {
      const embeddingProvider = makeEmbeddingProvider();
      const manyResults = Array.from({ length: 15 }, (_, i) =>
        makeSearchResult(`note-${i}.md`, 0.9 - i * 0.03),
      );
      const searchEngine = makeSearchEngine({
        findNeighbors: vi.fn().mockReturnValue(manyResults),
      });

      const output = await executeRetrieval({
        query: 'test query',
        mode: 'deep',
        sources,
        embeddingProvider,
        searchEngine,
      });

      expect(output.results).toHaveLength(8);
    });
  });
});
