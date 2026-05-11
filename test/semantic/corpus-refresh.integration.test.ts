import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSemanticModule } from '../../src/modules/semantic/index.js';
import type { ToolRegistration } from '../../src/lib/tool-registration.js';

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

    const semantic = await createSemanticModule(
      { vaultPath, smartEnvPath, modelKey: MODEL_KEY, modelId: MODEL_KEY },
      { embeddingServiceFactory: () => fakeEmbed },
    );

    const statsTool = findTool(semantic.tools, 'get_stats');
    // handler returns CallToolResult; the structured data lives in structuredContent.
    const beforeResult = await statsTool.handler({});
    expect(beforeResult.structuredContent).toMatchObject({ totalNotes: 1 });

    // Add a second note + shard.
    await fs.writeFile(path.join(vaultPath, 'B.md'), '# B\n');
    await fs.writeFile(path.join(smartEnvPath, 'b.ajson'), ajsonSource('B.md', [1, 0, 0]));

    const afterResult = await statsTool.handler({});
    expect(afterResult.structuredContent).toMatchObject({ totalNotes: 2 });
  });
});
