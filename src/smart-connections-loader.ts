import fs from 'node:fs/promises';
import path from 'node:path';

import type { SmartBlock, SmartSource } from './types.js';

interface SmartConnectionsRecord {
  path: unknown;
  embedding: unknown;
  blocks?: unknown;
}

export interface SmartConnectionsCorpus {
  sources: Map<string, SmartSource>;
}

export interface SmartConnectionsCorpusStats {
  totalNotes: number;
  totalBlocks: number;
  embeddingDimension: number;
}

function toPosixPath(notePath: string) {
  return notePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseSmartConnectionsRecord(
  rawJson: string,
  filePath: string,
): SmartSource {
  let parsed: SmartConnectionsRecord;

  try {
    parsed = JSON.parse(rawJson) as SmartConnectionsRecord;
  } catch (error) {
    throw new Error(
      `Failed to parse Smart Connections file ${filePath}: ${(error as Error).message}`,
    );
  }

  if (typeof parsed.path !== 'string' || parsed.path.trim() === '') {
    throw new Error(
      `Smart Connections file ${filePath} is missing a usable note path`,
    );
  }

  if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) {
    throw new Error(
      `Smart Connections file ${filePath} is missing a usable embedding vector`,
    );
  }

  const embedding = parsed.embedding.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(
        `Smart Connections file ${filePath} has a non-numeric embedding value at index ${index}`,
      );
    }

    return value;
  });

  const blocks = Array.isArray(parsed.blocks)
    ? (parsed.blocks as SmartBlock[])
    : [];

  return {
    path: toPosixPath(parsed.path),
    embedding,
    blocks,
  };
}

export async function loadSmartConnectionsCorpus(
  smartEnvPath: string,
): Promise<SmartConnectionsCorpus> {
  let dirEntries: Awaited<ReturnType<typeof fs.readdir>>;

  try {
    dirEntries = await fs.readdir(smartEnvPath, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `Smart Connections directory does not exist or cannot be read: ${smartEnvPath}`,
      { cause: error },
    );
  }

  const files = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ajson'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const sources = new Map<string, SmartSource>();

  for (const fileName of files) {
    const filePath = path.join(smartEnvPath, fileName);
    const rawJson = await fs.readFile(filePath, 'utf8');
    const source = parseSmartConnectionsRecord(rawJson, filePath);

    sources.set(source.path, source);
  }

  if (sources.size === 0) {
    throw new Error(
      `No usable Smart Connections notes were found in ${smartEnvPath}`,
    );
  }

  return { sources };
}

export function summarizeSmartConnectionsCorpus(
  corpus: SmartConnectionsCorpus,
): SmartConnectionsCorpusStats {
  let totalBlocks = 0;
  let embeddingDimension = 0;

  for (const source of corpus.sources.values()) {
    totalBlocks += source.blocks.length;
    embeddingDimension = Math.max(embeddingDimension, source.embedding.length);
  }

  return {
    totalNotes: corpus.sources.size,
    totalBlocks,
    embeddingDimension,
  };
}
