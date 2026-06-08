import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSemanticModule } from '../../src/modules/semantic/index.js';
import { createSmartConnectionsCorpusIndex } from '../../src/lib/obsidian/smart-connections-corpus-index.js';
import { WikilinkGraphIndex } from '../../src/lib/obsidian/wikilink-graph.js';
import { FsVaultReader } from '../../src/lib/obsidian/vault-reader.js';
import { createListMatchingPaths } from '../../src/lib/obsidian/query/index.js';
import type { ToolRegistration } from '../../src/lib/tool-registration.js';
import type { IVaultRegistry, IVaultEntry } from '../../src/lib/vault-registry.js';
import type { VaultWriter } from '../../src/lib/obsidian/vault-writer.js';
import type { VaultProvider } from '../../src/lib/obsidian/vault-provider.js';

const MODEL_KEY = 'bge-micro-v2';

// Build a minimal valid .ajson body for a single note source.
// The embeddings field uses { "bge-micro-v2": { "vec": [...] } } format,
// matching what findEmbeddingVector() expects (key.includes(modelKey)).
function ajsonSource(notePath: string, vec: number[]): string {
  const sourceKey = `smart_sources:${notePath}`;
  const blockKey = `smart_blocks:${notePath}#heading`;
  const sourceVal = JSON.stringify({
    path: notePath,
    embeddings: { [MODEL_KEY]: { vec } },
    blocks: { '#heading': [1, 3] },
  });
  const blockVal = JSON.stringify({
    embeddings: { [MODEL_KEY]: { vec } },
  });
  return `"${sourceKey}": ${sourceVal},\n"${blockKey}": ${blockVal}`;
}

// ToolRegistration shape is { name, spec, handler } — not { tool: { name, handler } }.
function findTool(tools: ToolRegistration[], name: string): ToolRegistration {
  const match = tools.find((t) => t.name === name);
  if (!match) throw new Error(`Tool not found: ${name}`);
  return match;
}

function makeRegistryForEntry(entry: IVaultEntry): IVaultRegistry {
  return {
    get: vi.fn(),
    require: vi.fn(),
    list: vi.fn(() => [entry]),
    isMulti: vi.fn(() => false),
    names: vi.fn(() => [entry.name]),
    semanticAvailableEntries: vi.fn(() => (entry.semanticAvailable ? [entry] : [])),
  };
}

describe('corpus refresh through semantic tools', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs) await fs.rm(d, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  it('picks up a new note when an ajson file is added between calls', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'corpus-refresh-int-'));
    tempDirs.push(tempRoot);

    const vaultPath = path.join(tempRoot, 'vault');
    const smartEnvPath = path.join(vaultPath, '.smart-env', 'multi');
    await fs.mkdir(smartEnvPath, { recursive: true });

    // Seed: one note on disk, one ajson shard.
    await fs.writeFile(path.join(vaultPath, 'A.md'), '# A\n');
    await fs.writeFile(path.join(smartEnvPath, 'a.ajson'), ajsonSource('A.md', [1, 0, 0]));

    const fakeEmbed = {
      initialize: vi.fn(),
      embed: vi.fn().mockResolvedValue([[1, 0, 0]]),
    };

    // Build the corpus directly (the registry normally does this at startup).
    const corpus = await createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey: MODEL_KEY });

    const reader = new FsVaultReader({ vaultRoot: vaultPath });
    const graph = new WikilinkGraphIndex({ reader });
    const listMatchingPaths = createListMatchingPaths({ reader, graph });

    const entry: IVaultEntry = {
      name: 'vault',
      path: vaultPath,
      smartEnvPath,
      reader,
      writer: {} as VaultWriter,
      provider: {} as VaultProvider,
      graph,
      listMatchingPaths,
      corpus,
      semanticAvailable: true,
    };

    const registry = makeRegistryForEntry(entry);

    const semantic = createSemanticModule(
      registry,
      { modelKey: MODEL_KEY, modelId: MODEL_KEY },
      { embeddingServiceFactory: () => fakeEmbed },
    );

    // find_duplicates snapshots the corpus on each call. With a single seeded
    // note there are no pairs; after a second identical-embedding note is added
    // the refreshed snapshot yields exactly one near-duplicate pair.
    const dupTool = findTool(semantic.tools, 'find_duplicates');
    // handler returns CallToolResult; an array payload is carried as JSON text
    // (structuredContent is only set for plain-object payloads).
    const parsePairs = (
      result: Awaited<ReturnType<typeof dupTool.handler>>,
    ): Array<{ note_a: string; note_b: string }> => {
      const block = result.content[0];
      if (block.type !== 'text') throw new Error('expected text content block');
      return JSON.parse(block.text) as Array<{ note_a: string; note_b: string }>;
    };

    const beforeResult = await dupTool.handler({});
    expect(parsePairs(beforeResult)).toEqual([]);

    // Add a second note + shard with an identical embedding.
    await fs.writeFile(path.join(vaultPath, 'B.md'), '# B\n');
    await fs.writeFile(path.join(smartEnvPath, 'b.ajson'), ajsonSource('B.md', [1, 0, 0]));

    const afterResult = await dupTool.handler({});
    expect(parsePairs(afterResult)).toMatchObject([{ note_a: 'A.md', note_b: 'B.md' }]);
  });
});
