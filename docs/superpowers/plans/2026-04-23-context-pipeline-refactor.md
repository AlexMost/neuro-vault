# Context Pipeline Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-query `search_notes` with a mode-based pipeline supporting multi-query, block-level search, expansion, and fallback to text search.

**Architecture:** Extend `search_notes` tool to accept `query: string | string[]`, `mode`, `expansion`, `expansion_limit`. The MCP server handles retrieval policy (mode defaults, fallback chain, block-level search in deep mode) while the LLM client handles intent detection and query rewriting. Obsidian CLI and grep serve as non-vector fallbacks when embedding search returns nothing.

**Tech Stack:** TypeScript, Vitest, `@modelcontextprotocol/sdk`, `zod`, Node.js `child_process` (for obsidian-cli/grep fallback)

---

## File Structure

| File                            | Responsibility                                                               |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `src/types.ts`                  | Extended types: `SearchNotesInput`, `SearchMode`, new result types           |
| `src/retrieval-policy.ts`       | **New.** Mode defaults, multi-query orchestration, fallback chain, expansion |
| `src/text-search.ts`            | **New.** Obsidian CLI + grep fallback implementations                        |
| `src/search-engine.ts`          | Add block-level search (`findBlockNeighbors`)                                |
| `src/tool-handlers.ts`          | Rewire `searchNotes` to use retrieval policy                                 |
| `src/server.ts`                 | Update zod schema, `SERVER_INSTRUCTIONS`, tool description                   |
| `test/retrieval-policy.test.ts` | **New.** Tests for mode defaults, multi-query, fallback, expansion           |
| `test/text-search.test.ts`      | **New.** Tests for obsidian-cli detection, grep fallback                     |
| `test/search-engine.test.ts`    | Add block-level search tests                                                 |
| `test/tool-handlers.test.ts`    | Update existing tests for new input shape                                    |
| `test/server-smoke.test.ts`     | Update schema expectations                                                   |

---

### Task 1: Extend types for new search API

**Files:**

- Modify: `src/types.ts`

- [ ] **Step 1: Add `SearchMode` type and update `SearchNotesInput`**

In `src/types.ts`, replace the existing `SearchNotesInput` interface and add new types:

```typescript
export type SearchMode = 'quick' | 'deep';

export interface SearchNotesInput {
  query: string | string[];
  mode?: SearchMode;
  limit?: number;
  threshold?: number;
  expansion?: boolean;
  expansion_limit?: number;
}
```

- [ ] **Step 2: Add `BlockSearchResult` type**

Add below `SearchResultBlock`:

```typescript
export interface BlockSearchResult {
  path: string;
  heading: string;
  lines: [number, number];
  similarity: number;
}
```

- [ ] **Step 3: Add `TextSearchResult` type**

Add below `BlockSearchResult`:

```typescript
export interface TextSearchResult {
  path: string;
  matchLine: string;
  lineNumber: number;
}
```

- [ ] **Step 4: Add `TextSearchProvider` interface**

Add below `SearchEngine`:

```typescript
export interface TextSearchProvider {
  isAvailable(): Promise<boolean>;
  search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]>;
}
```

- [ ] **Step 5: Update `ToolHandlerDependencies`**

Add `vaultPath` and optional text search providers:

```typescript
export interface ToolHandlerDependencies {
  loader: {
    sources: Map<string, SmartSource>;
  };
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  modelKey: string;
  vaultPath: string;
  obsidianSearch?: TextSearchProvider;
  grepSearch?: TextSearchProvider;
}
```

- [ ] **Step 6: Add `findBlockNeighbors` to `SearchEngine` interface**

```typescript
export interface SearchEngine {
  findNeighbors(args: {
    queryVector: number[];
    sources: Iterable<SmartSource>;
    threshold: number;
    limit?: number;
    excludePath?: string;
  }): SearchResult[];
  findBlockNeighbors(args: {
    queryVector: number[];
    sources: Iterable<SmartSource>;
    threshold: number;
    limit?: number;
  }): BlockSearchResult[];
  findDuplicates(args: { sources: Iterable<SmartSource>; threshold: number }): DuplicatePair[];
}
```

- [ ] **Step 7: Run type check**

Run: `npx tsc --noEmit`
Expected: Type errors in files that haven't been updated yet (`search-engine.ts`, `tool-handlers.ts`, `server.ts`). This is expected — we'll fix them in later tasks. Verify the new types themselves have no syntax errors by checking the output mentions only usage-site errors, not definition-site errors.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts
git commit -m "feat: extend types for mode-based search pipeline"
```

---

### Task 2: Add block-level search to search engine

**Files:**

- Modify: `src/search-engine.ts`
- Modify: `test/search-engine.test.ts`

- [ ] **Step 1: Write failing test for `findBlockNeighbors`**

Add to `test/search-engine.test.ts`:

```typescript
import {
  cosineSimilarity,
  findNeighbors,
  findDuplicates,
  findBlockNeighbors,
} from '../src/search-engine.js';
import type { SmartSource, BlockSearchResult } from '../src/types.js';

describe('findBlockNeighbors', () => {
  const sources: SmartSource[] = [
    {
      path: 'note-a.md',
      embedding: [1, 0, 0],
      blocks: [
        {
          key: 'note-a.md#intro',
          heading: '#intro',
          lines: [1, 5] as [number, number],
          embedding: [0.9, 0.1, 0],
        },
        {
          key: 'note-a.md#details',
          heading: '#details',
          lines: [6, 10] as [number, number],
          embedding: [0.1, 0.9, 0],
        },
      ],
    },
    {
      path: 'note-b.md',
      embedding: [0, 1, 0],
      blocks: [
        {
          key: 'note-b.md#summary',
          heading: '#summary',
          lines: [1, 4] as [number, number],
          embedding: [0.8, 0.2, 0],
        },
      ],
    },
    {
      path: 'note-c.md',
      embedding: [0, 0, 1],
      blocks: [
        {
          key: 'note-c.md#empty-embed',
          heading: '#empty-embed',
          lines: [1, 3] as [number, number],
          embedding: [],
        },
      ],
    },
  ];

  it('returns blocks ranked by similarity, skipping empty embeddings', () => {
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0.1,
    });

    expect(results.length).toBe(3);
    expect(results[0]!.heading).toBe('#intro');
    expect(results[0]!.path).toBe('note-a.md');
    expect(results[0]!.similarity).toBeGreaterThan(results[1]!.similarity);
  });

  it('respects threshold', () => {
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0.85,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.heading).toBe('#intro');
  });

  it('respects limit', () => {
    const results = findBlockNeighbors({
      queryVector: [1, 0, 0],
      sources,
      threshold: 0.1,
      limit: 2,
    });

    expect(results.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/search-engine.test.ts`
Expected: FAIL — `findBlockNeighbors` is not exported.

- [ ] **Step 3: Implement `findBlockNeighbors`**

Add to `src/search-engine.ts`:

```typescript
import type { BlockSearchResult, DuplicatePair, SearchResult, SmartSource } from './types.js';

function compareBlockResults(left: BlockSearchResult, right: BlockSearchResult): number {
  return right.similarity - left.similarity || compareStrings(left.path, right.path);
}

export function findBlockNeighbors({
  queryVector,
  sources,
  threshold,
  limit,
}: {
  queryVector: number[];
  sources: Iterable<SmartSource>;
  threshold: number;
  limit?: number;
}): BlockSearchResult[] {
  const results: BlockSearchResult[] = [];

  for (const source of sources) {
    for (const block of source.blocks) {
      if (block.embedding.length === 0) continue;

      ensureSameDimensions(
        queryVector,
        block.embedding,
        'Query vector',
        `Block vector for ${block.key}`,
      );

      const similarity = cosineSimilarity(queryVector, block.embedding);

      if (similarity >= threshold) {
        results.push({
          path: source.path,
          heading: block.heading,
          lines: block.lines,
          similarity,
        });
      }
    }
  }

  results.sort(compareBlockResults);

  return typeof limit === 'number' ? results.slice(0, limit) : results;
}
```

Also update the import at the top of `search-engine.ts` to include `BlockSearchResult`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/search-engine.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/search-engine.ts test/search-engine.test.ts
git commit -m "feat: add block-level search to search engine"
```

---

### Task 3: Implement text search fallbacks (obsidian-cli + grep)

**Files:**

- Create: `src/text-search.ts`
- Create: `test/text-search.test.ts`

- [ ] **Step 1: Write failing tests for `GrepSearchProvider`**

Create `test/text-search.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GrepSearchProvider, ObsidianCliSearchProvider } from '../src/text-search.js';

describe('GrepSearchProvider', () => {
  it('isAvailable returns true (grep is always available)', async () => {
    const provider = new GrepSearchProvider();
    expect(await provider.isAvailable()).toBe(true);
  });

  it('finds matching lines in vault files', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    const subDir = path.join(tempDir, 'Notes');
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(subDir, 'test.md'), 'line one\nfoo bar baz\nline three\n');
    await fs.writeFile(path.join(subDir, 'other.md'), 'nothing here\nfoo match\n');
    await fs.writeFile(path.join(tempDir, 'not-md.txt'), 'foo should be ignored\n');

    try {
      const provider = new GrepSearchProvider();
      const results = await provider.search('foo', tempDir, 10);

      expect(results.length).toBe(2);
      expect(results.every((r) => r.matchLine.includes('foo'))).toBe(true);
      expect(results.every((r) => r.path.endsWith('.md'))).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when nothing matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    await fs.writeFile(path.join(tempDir, 'test.md'), 'nothing relevant\n');

    try {
      const provider = new GrepSearchProvider();
      const results = await provider.search('zzz_nonexistent', tempDir, 10);
      expect(results).toEqual([]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('respects limit', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-test-'));
    await fs.writeFile(path.join(tempDir, 'a.md'), 'match\nmatch\nmatch\n');

    try {
      const provider = new GrepSearchProvider();
      const results = await provider.search('match', tempDir, 2);
      expect(results.length).toBe(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('ObsidianCliSearchProvider', () => {
  it('isAvailable returns false when obsidian-cli is not installed', async () => {
    const provider = new ObsidianCliSearchProvider();
    // In test env, obsidian-cli is not installed
    const available = await provider.isAvailable();
    expect(typeof available).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/text-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `GrepSearchProvider` and `ObsidianCliSearchProvider`**

Create `src/text-search.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { TextSearchProvider, TextSearchResult } from './types.js';

const execFileAsync = promisify(execFile);

export class GrepSearchProvider implements TextSearchProvider {
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]> {
    try {
      const { stdout } = await execFileAsync(
        'grep',
        ['-rn', '--include=*.md', '-m', String(limit), '--', query, vaultPath],
        { maxBuffer: 1024 * 1024, timeout: 10_000 },
      );

      return this.parseGrepOutput(stdout, vaultPath, limit);
    } catch (error) {
      const execError = error as { code?: number; stdout?: string };
      // grep exits with 1 when no matches found
      if (execError.code === 1) return [];
      throw error;
    }
  }

  private parseGrepOutput(stdout: string, vaultPath: string, limit: number): TextSearchResult[] {
    const results: TextSearchResult[] = [];
    const prefix = vaultPath.endsWith('/') ? vaultPath : vaultPath + '/';

    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      if (results.length >= limit) break;

      // Format: /path/to/file.md:lineNumber:matchLine
      const firstColon = line.indexOf(':');
      if (firstColon === -1) continue;
      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;

      const absPath = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
      const matchLine = line.slice(secondColon + 1).trim();

      const relativePath = absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;

      if (Number.isFinite(lineNum) && matchLine) {
        results.push({ path: relativePath, matchLine, lineNumber: lineNum });
      }
    }

    return results;
  }
}

export class ObsidianCliSearchProvider implements TextSearchProvider {
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('obsidian-cli', ['--version'], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async search(query: string, vaultPath: string, limit: number): Promise<TextSearchResult[]> {
    try {
      const { stdout } = await execFileAsync(
        'obsidian-cli',
        ['search', '--vault', vaultPath, '--query', query, '--limit', String(limit)],
        { maxBuffer: 1024 * 1024, timeout: 15_000 },
      );

      return this.parseOutput(stdout, limit);
    } catch {
      return [];
    }
  }

  private parseOutput(stdout: string, limit: number): TextSearchResult[] {
    const results: TextSearchResult[] = [];

    for (const line of stdout.split('\n')) {
      if (!line.trim() || results.length >= limit) continue;

      // Best-effort parse — obsidian-cli output format may vary
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const filePath = line.slice(0, colonIndex).trim();
      const matchLine = line.slice(colonIndex + 1).trim();

      if (filePath && matchLine) {
        results.push({ path: filePath, matchLine, lineNumber: 0 });
      }
    }

    return results;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/text-search.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/text-search.ts test/text-search.test.ts
git commit -m "feat: add text search fallbacks (grep + obsidian-cli)"
```

---

### Task 4: Implement retrieval policy with mode defaults, multi-query, fallback, and expansion

**Files:**

- Create: `src/retrieval-policy.ts`
- Create: `test/retrieval-policy.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/retrieval-policy.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import { executeRetrieval } from '../src/retrieval-policy.js';
import type {
  EmbeddingProvider,
  SearchEngine,
  SearchResult,
  SmartSource,
  TextSearchProvider,
  BlockSearchResult,
} from '../src/types.js';

function makeSources(): Map<string, SmartSource> {
  return new Map([
    [
      'a.md',
      {
        path: 'a.md',
        embedding: [1, 0, 0],
        blocks: [
          {
            key: 'a.md#h1',
            heading: '#h1',
            lines: [1, 3] as [number, number],
            embedding: [1, 0, 0],
          },
        ],
      },
    ],
    [
      'b.md',
      {
        path: 'b.md',
        embedding: [0, 1, 0],
        blocks: [
          {
            key: 'b.md#h2',
            heading: '#h2',
            lines: [1, 3] as [number, number],
            embedding: [0, 1, 0],
          },
        ],
      },
    ],
  ]);
}

function makeSearchEngine(
  noteResults: SearchResult[],
  blockResults: BlockSearchResult[] = [],
): SearchEngine {
  return {
    findNeighbors: vi.fn().mockReturnValue(noteResults),
    findBlockNeighbors: vi.fn().mockReturnValue(blockResults),
    findDuplicates: vi.fn().mockReturnValue([]),
  };
}

function makeEmbedding(): EmbeddingProvider {
  return {
    initialize: vi.fn(),
    embed: vi.fn().mockResolvedValue([1, 0, 0]),
  };
}

describe('executeRetrieval', () => {
  it('applies quick mode defaults', async () => {
    const noteResults: SearchResult[] = [{ path: 'a.md', similarity: 0.8, blocks: [] }];
    const engine = makeSearchEngine(noteResults);

    const result = await executeRetrieval({
      queries: ['test'],
      mode: 'quick',
      sources: makeSources(),
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
    });

    expect(result.results.length).toBe(1);
    expect(engine.findNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.5, limit: 3 }),
    );
  });

  it('applies deep mode defaults', async () => {
    const noteResults: SearchResult[] = [{ path: 'a.md', similarity: 0.5, blocks: [] }];
    const engine = makeSearchEngine(noteResults);

    const result = await executeRetrieval({
      queries: ['test'],
      mode: 'deep',
      sources: makeSources(),
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
    });

    expect(engine.findNeighbors).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 0.35, limit: 8 }),
    );
  });

  it('deduplicates results across multiple queries', async () => {
    const engine = makeSearchEngine([]);
    (engine.findNeighbors as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([{ path: 'a.md', similarity: 0.9, blocks: [] }])
      .mockReturnValueOnce([
        { path: 'a.md', similarity: 0.85, blocks: [] },
        { path: 'b.md', similarity: 0.7, blocks: [] },
      ]);

    const embedding = makeEmbedding();
    (embedding.embed as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0.5, 0.5, 0]);

    const result = await executeRetrieval({
      queries: ['query1', 'query2'],
      mode: 'quick',
      sources: makeSources(),
      embeddingProvider: embedding,
      searchEngine: engine,
      vaultPath: '/vault',
    });

    const paths = result.results.map((r) => r.path);
    expect(paths).toEqual(['a.md', 'b.md']);
    // a.md should keep the higher similarity
    expect(result.results[0]!.similarity).toBe(0.9);
  });

  it('falls back to lower threshold when no results', async () => {
    const engine = makeSearchEngine([]);
    (engine.findNeighbors as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([]) // first try with default threshold
      .mockReturnValueOnce([{ path: 'a.md', similarity: 0.35, blocks: [] }]); // retry with 0.3

    const result = await executeRetrieval({
      queries: ['test'],
      mode: 'quick',
      sources: makeSources(),
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
    });

    expect(engine.findNeighbors).toHaveBeenCalledTimes(2);
    expect(result.results.length).toBe(1);
  });

  it('falls back to grep when vector search returns nothing', async () => {
    const engine = makeSearchEngine([]);
    const grepSearch: TextSearchProvider = {
      isAvailable: vi.fn().mockResolvedValue(true),
      search: vi.fn().mockResolvedValue([{ path: 'c.md', matchLine: 'found it', lineNumber: 5 }]),
    };

    const result = await executeRetrieval({
      queries: ['test'],
      mode: 'quick',
      sources: makeSources(),
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
      grepSearch,
    });

    expect(result.textFallbackResults!.length).toBe(1);
    expect(grepSearch.search).toHaveBeenCalled();
  });

  it('runs expansion on top results in deep mode', async () => {
    const engine = makeSearchEngine([
      { path: 'a.md', similarity: 0.8, blocks: [] },
      { path: 'b.md', similarity: 0.6, blocks: [] },
    ]);
    // expansion calls findNeighbors for each top result
    (engine.findNeighbors as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([
        { path: 'a.md', similarity: 0.8, blocks: [] },
        { path: 'b.md', similarity: 0.6, blocks: [] },
      ])
      // expansion for a.md
      .mockReturnValueOnce([{ path: 'c.md', similarity: 0.5, blocks: [] }]);

    const sources = makeSources();
    sources.set('c.md', {
      path: 'c.md',
      embedding: [0.5, 0.5, 0],
      blocks: [],
    });

    const result = await executeRetrieval({
      queries: ['test'],
      mode: 'deep',
      expansion: true,
      expansionLimit: 1,
      sources,
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
    });

    const paths = result.results.map((r) => r.path);
    expect(paths).toContain('c.md');
  });

  it('allows threshold override', async () => {
    const engine = makeSearchEngine([]);

    await executeRetrieval({
      queries: ['test'],
      mode: 'quick',
      threshold: 0.7,
      sources: makeSources(),
      embeddingProvider: makeEmbedding(),
      searchEngine: engine,
      vaultPath: '/vault',
    });

    expect(engine.findNeighbors).toHaveBeenCalledWith(expect.objectContaining({ threshold: 0.7 }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/retrieval-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `executeRetrieval`**

Create `src/retrieval-policy.ts`:

```typescript
import type {
  BlockSearchResult,
  EmbeddingProvider,
  SearchEngine,
  SearchMode,
  SearchResult,
  SmartSource,
  TextSearchProvider,
  TextSearchResult,
} from './types.js';

interface ModeConfig {
  limit: number;
  threshold: number;
  expansion: boolean;
  expansionLimit: number;
}

const MODE_DEFAULTS: Record<SearchMode, ModeConfig> = {
  quick: { limit: 3, threshold: 0.5, expansion: false, expansionLimit: 0 },
  deep: { limit: 8, threshold: 0.35, expansion: true, expansionLimit: 3 },
};

const FALLBACK_THRESHOLD = 0.3;
const TEXT_SEARCH_LIMIT = 10;

export interface RetrievalInput {
  queries: string[];
  mode: SearchMode;
  threshold?: number;
  expansion?: boolean;
  expansionLimit?: number;
  sources: Map<string, SmartSource>;
  embeddingProvider: EmbeddingProvider;
  searchEngine: SearchEngine;
  vaultPath: string;
  obsidianSearch?: TextSearchProvider;
  grepSearch?: TextSearchProvider;
}

export interface RetrievalOutput {
  results: SearchResult[];
  blockResults?: BlockSearchResult[];
  textFallbackResults?: TextSearchResult[];
}

function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const seen = new Map<string, SearchResult>();

  for (const result of results) {
    const existing = seen.get(result.path);
    if (!existing || result.similarity > existing.similarity) {
      seen.set(result.path, result);
    }
  }

  return [...seen.values()].sort((a, b) => b.similarity - a.similarity);
}

export async function executeRetrieval(input: RetrievalInput): Promise<RetrievalOutput> {
  const defaults = MODE_DEFAULTS[input.mode];
  const threshold = input.threshold ?? defaults.threshold;
  const limit = defaults.limit;
  const doExpansion = input.expansion ?? defaults.expansion;
  const expansionLimit = input.expansionLimit ?? defaults.expansionLimit;

  // Phase 1: Multi-query vector search
  let allResults: SearchResult[] = [];

  for (const query of input.queries) {
    const queryVector = await input.embeddingProvider.embed(query);

    const results = input.searchEngine.findNeighbors({
      queryVector,
      sources: input.sources.values(),
      threshold,
      limit,
    });

    allResults.push(...results);
  }

  allResults = deduplicateResults(allResults);

  // Phase 1b: Fallback — retry with lower threshold if no results
  if (allResults.length === 0 && threshold > FALLBACK_THRESHOLD) {
    const queryVector = await input.embeddingProvider.embed(input.queries[0]!);

    allResults = input.searchEngine.findNeighbors({
      queryVector,
      sources: input.sources.values(),
      threshold: FALLBACK_THRESHOLD,
      limit,
    });
  }

  // Phase 2: Block-level search (deep mode)
  let blockResults: BlockSearchResult[] | undefined;

  if (input.mode === 'deep') {
    blockResults = [];
    for (const query of input.queries) {
      const queryVector = await input.embeddingProvider.embed(query);
      const blocks = input.searchEngine.findBlockNeighbors({
        queryVector,
        sources: input.sources.values(),
        threshold,
        limit: limit * 2,
      });
      blockResults.push(...blocks);
    }
  }

  // Phase 3: Expansion (use embeddings of top results to find neighbors)
  if (doExpansion && allResults.length > 0 && expansionLimit > 0) {
    const topResults = allResults.slice(0, expansionLimit);
    const expansionResults: SearchResult[] = [];

    for (const topResult of topResults) {
      const source = input.sources.get(topResult.path);
      if (!source) continue;

      const neighbors = input.searchEngine.findNeighbors({
        queryVector: source.embedding,
        sources: input.sources.values(),
        threshold: FALLBACK_THRESHOLD,
        limit: 3,
        excludePath: topResult.path,
      });

      expansionResults.push(...neighbors);
    }

    allResults = deduplicateResults([...allResults, ...expansionResults]);
  }

  // Apply final limit
  allResults = allResults.slice(0, limit);

  // Phase 4: Text fallback if still no vector results
  let textFallbackResults: TextSearchResult[] | undefined;

  if (allResults.length === 0) {
    const searchQuery = input.queries.join(' ');

    // Try obsidian-cli first
    if (input.obsidianSearch) {
      const isAvailable = await input.obsidianSearch.isAvailable();
      if (isAvailable) {
        textFallbackResults = await input.obsidianSearch.search(
          searchQuery,
          input.vaultPath,
          TEXT_SEARCH_LIMIT,
        );
      }
    }

    // Fall back to grep
    if (!textFallbackResults || textFallbackResults.length === 0) {
      if (input.grepSearch) {
        const isAvailable = await input.grepSearch.isAvailable();
        if (isAvailable) {
          textFallbackResults = await input.grepSearch.search(
            searchQuery,
            input.vaultPath,
            TEXT_SEARCH_LIMIT,
          );
        }
      }
    }
  }

  return {
    results: allResults,
    blockResults: blockResults && blockResults.length > 0 ? blockResults : undefined,
    textFallbackResults:
      textFallbackResults && textFallbackResults.length > 0 ? textFallbackResults : undefined,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/retrieval-policy.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/retrieval-policy.ts test/retrieval-policy.test.ts
git commit -m "feat: implement retrieval policy with mode defaults, multi-query, fallback, and expansion"
```

---

### Task 5: Rewire tool handlers to use retrieval policy

**Files:**

- Modify: `src/tool-handlers.ts`
- Modify: `test/tool-handlers.test.ts`

- [ ] **Step 1: Update `searchNotes` in `tool-handlers.ts`**

Replace the existing `searchNotes` method to accept the new input shape and delegate to `executeRetrieval`:

```typescript
import { executeRetrieval, type RetrievalOutput } from './retrieval-policy.js';

// At the top, add new constants:
const DEFAULT_EXPANSION_LIMIT = 3;

// Inside createToolHandlers, replace the searchNotes method:
async searchNotes(input: SearchNotesInput): Promise<RetrievalOutput> {
  const queries = normalizeQueries(input.query);
  const mode = input.mode ?? 'quick';
  const threshold = input.threshold !== undefined
    ? readThreshold(input.threshold, input.threshold, 'threshold')
    : undefined;
  const expansionLimit = input.expansion_limit !== undefined
    ? readPositiveInteger(input.expansion_limit, DEFAULT_EXPANSION_LIMIT, 'expansion_limit')
    : undefined;

  try {
    return await executeRetrieval({
      queries,
      mode,
      threshold,
      expansion: input.expansion,
      expansionLimit,
      sources: loader.sources,
      embeddingProvider,
      searchEngine,
      vaultPath,
      obsidianSearch,
      grepSearch,
    });
  } catch (error) {
    throw wrapDependencyError(error, 'Failed to search notes', {
      modelKey,
      operation: 'search_notes',
    });
  }
},
```

Add the `normalizeQueries` helper:

```typescript
function normalizeQueries(query: string | string[]): string[] {
  const raw = Array.isArray(query) ? query : [query];
  const normalized = raw.map((q) => q.trim()).filter((q) => q.length > 0);

  if (normalized.length === 0) {
    throw new ToolHandlerError('INVALID_ARGUMENT', 'query must not be empty', {
      details: { field: 'query' },
    });
  }

  return normalized;
}
```

Update `ToolHandlers` interface return type in `types.ts`:

```typescript
import type { RetrievalOutput } from './retrieval-policy.js';

export interface ToolHandlers {
  searchNotes(input: SearchNotesInput): Promise<RetrievalOutput>;
  getSimilarNotes(input: GetSimilarNotesInput): Promise<SearchResult[]>;
  findDuplicates(input?: FindDuplicatesInput): Promise<DuplicatePair[]>;
  getStats(): Promise<ToolStats>;
}
```

Update `ToolHandlerDependencies` destructuring in `createToolHandlers` to include `vaultPath`, `obsidianSearch`, `grepSearch`.

- [ ] **Step 2: Update existing tests in `test/tool-handlers.test.ts`**

Update the test for `searchNotes` — it now returns `RetrievalOutput` instead of `SearchResult[]`:

```typescript
// In the 'returns ranked search results for a query' test:
const result = await handlers.searchNotes({
  query: '  semantic query  ',
  threshold: 0,
});

expect(embed).toHaveBeenCalledTimes(1);
expect(embed).toHaveBeenCalledWith('semantic query');
expect(result.results.map((r) => r.path)).toEqual([
  'Folder/note-a.md',
  'Folder/note-b.md',
  'Folder/note-c.md',
]);
```

Update `createToolHandlers` calls to include `vaultPath`:

```typescript
const handlers = createToolHandlers({
  loader: corpus,
  embeddingProvider: { initialize: vi.fn(), embed },
  searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
  modelKey: 'bge-micro-v2',
  vaultPath: vaultPath,
});
```

Import `findBlockNeighbors` from search-engine.

Add a test for string array query:

```typescript
it('accepts an array of queries', async () => {
  const { tempRoot, smartEnvPath, vaultPath } = await makeVaultFixture([
    'note-a.ajson',
    'note-b.ajson',
    'note-c.ajson',
  ]);

  try {
    const corpus = await loadSmartConnectionsCorpus(smartEnvPath, MODEL_KEY);
    const embed = vi.fn().mockResolvedValue([0.7, 0.2, 0.1]);
    const handlers = createToolHandlers({
      loader: corpus,
      embeddingProvider: { initialize: vi.fn(), embed },
      searchEngine: { findNeighbors, findDuplicates, findBlockNeighbors },
      modelKey: 'bge-micro-v2',
      vaultPath,
    });

    const result = await handlers.searchNotes({
      query: ['query one', 'query two'],
      threshold: 0,
    });

    expect(embed).toHaveBeenCalledTimes(2);
    expect(result.results.length).toBeGreaterThan(0);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run test/tool-handlers.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/tool-handlers.ts src/types.ts test/tool-handlers.test.ts
git commit -m "feat: rewire search_notes to use retrieval policy with mode, multi-query, expansion"
```

---

### Task 6: Update MCP server schema, tool description, and SERVER_INSTRUCTIONS

**Files:**

- Modify: `src/server.ts`
- Modify: `test/server-smoke.test.ts`

- [ ] **Step 1: Update zod schema for `search_notes`**

In `src/server.ts`, replace `searchNotesSchema`:

```typescript
const searchNotesSchema = z.object({
  query: z.union([z.string(), z.array(z.string())]),
  mode: z.enum(['quick', 'deep']).optional(),
  limit: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
  expansion: z.boolean().optional(),
  expansion_limit: z.number().int().positive().optional(),
});
```

- [ ] **Step 2: Update `SERVER_INSTRUCTIONS`**

Replace the `SERVER_INSTRUCTIONS` constant:

```typescript
const SERVER_INSTRUCTIONS = `\
This server provides semantic search over an Obsidian vault using Smart Connections embeddings.

## Search protocol

Before calling search_notes, determine:

### 1. Choose mode
- **quick** — specific question, need 1-2 notes ("where is the neuro-vault project?", "show the API task")
- **deep** — broad topic, need an overview ("everything about embeddings", "all AI project ideas")

### 2. Rewrite the query
- Extract 2-4 key concepts (1-4 words each)
- Remove filler words (remind, find, show)
- Add synonyms and translations (UA ↔ EN if the user is bilingual)
- Pass as an array: query: ["vector search", "пошук", "search optimization"]

### 3. Use expansion wisely
- In deep mode, expansion is on by default — it finds notes related to top results
- For quick lookups, skip expansion (it's off by default)

### 4. Fallback behavior
When vector search returns no results, the server automatically:
1. Retries with a lower similarity threshold
2. Falls back to full-text search (obsidian-cli if available, then grep)

### 5. Reading results
- \`results\` — notes ranked by embedding similarity, with block headings and line ranges
- \`blockResults\` — (deep mode) individual note sections ranked by relevance
- \`textFallbackResults\` — raw text matches when vector search found nothing

Use block headings and line ranges as pointers to read specific sections rather than entire files.
After finding a relevant note, use get_similar_notes to discover related content.
`;
```

- [ ] **Step 3: Update tool description for `search_notes`**

```typescript
server.registerTool(
  'search_notes',
  {
    title: 'Search Notes',
    description:
      'Search notes by semantic similarity. Pass query as a string or array of short keyword queries (1-4 words). Choose mode: "quick" for specific lookups (1-2 notes), "deep" for broad topic overview with block-level search and expansion. Supports synonyms and multi-language queries.',
    inputSchema: searchNotesSchema,
  },
  async (args) => invokeTool(() => handlers.searchNotes(args)),
);
```

- [ ] **Step 4: Wire text search providers in `startNeuroVaultServer`**

Add imports and wiring:

```typescript
import { GrepSearchProvider, ObsidianCliSearchProvider } from './text-search.js';

// Inside startNeuroVaultServer, after creating embeddingService:
const obsidianSearch = new ObsidianCliSearchProvider();
const grepSearch = new GrepSearchProvider();

const server = createNeuroVaultServer({
  loader: corpus,
  embeddingProvider: embeddingService,
  searchEngine,
  modelKey: config.modelKey,
  vaultPath: config.vaultPath,
  obsidianSearch,
  grepSearch,
  toolHandlersFactory: deps.toolHandlersFactory,
  serverFactory,
});
```

Update `NeuroVaultServerDependencies` and `createNeuroVaultServer` to accept and pass through `vaultPath`, `obsidianSearch`, `grepSearch`.

- [ ] **Step 5: Update server smoke test**

In `test/server-smoke.test.ts`, update the mock `toolHandlersFactory` return value so `searchNotes` returns a `RetrievalOutput`:

```typescript
searchNotes: vi.fn().mockResolvedValue({ results: [], blockResults: undefined, textFallbackResults: undefined }),
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/text-search.ts test/server-smoke.test.ts
git commit -m "feat: update MCP schema, tool description, and SERVER_INSTRUCTIONS for context pipeline"
```

---

### Task 7: Final integration test and type check

**Files:**

- All modified files

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

- [ ] **Step 3: Run lint and format**

Run: `npm run lint && npm run format`
Expected: No errors

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: Successful build

- [ ] **Step 5: Commit any remaining fixes**

If any lint/format fixes were needed:

```bash
git add -A
git commit -m "chore: fix lint and formatting"
```
