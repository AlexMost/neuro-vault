import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { SmartBlock, SmartSource } from './types.js';

interface AjsonEntry {
  key: string;
  value: Record<string, unknown>;
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
  const normalized = path.posix.normalize(notePath.trim().replace(/\\/g, '/'));

  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '.' ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(
      `Smart Connections path must be vault-relative and POSIX-like: ${notePath}`,
    );
  }

  return normalized.replace(/^\.\//, '');
}

export function parseAjsonContent(content: string): AjsonEntry[] {
  const entries: AjsonEntry[] = [];
  const len = content.length;
  let pos = 0;

  while (pos < len) {
    while (
      pos < len &&
      (content[pos] === ' ' ||
        content[pos] === '\t' ||
        content[pos] === '\n' ||
        content[pos] === '\r' ||
        content[pos] === ',')
    ) {
      pos++;
    }
    if (pos >= len) break;

    if (content[pos] !== '"') break;

    pos++;
    let key = '';
    while (pos < len && content[pos] !== '"') {
      if (content[pos] === '\\') {
        key += content[pos]!;
        pos++;
        if (pos < len) {
          key += content[pos]!;
          pos++;
        }
      } else {
        key += content[pos]!;
        pos++;
      }
    }
    if (pos >= len) {
      throw new Error('Unterminated key string in AJSON content');
    }
    pos++;

    while (pos < len && content[pos] !== ':') pos++;
    if (pos >= len) {
      throw new Error(`Missing colon after key "${key}" in AJSON content`);
    }
    pos++;

    while (pos < len && (content[pos] === ' ' || content[pos] === '\t')) pos++;

    if (pos >= len || content[pos] !== '{') {
      throw new Error(`Expected opening brace for key "${key}" in AJSON content`);
    }

    const braceStart = pos;
    let depth = 0;
    let inString = false;

    while (pos < len) {
      const ch = content[pos]!;
      if (inString) {
        if (ch === '\\') {
          pos++;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            pos++;
            break;
          }
        }
      }
      pos++;
    }

    if (depth !== 0) {
      throw new Error(`Unmatched braces for key "${key}" in AJSON content`);
    }

    const jsonStr = content.slice(braceStart, pos);

    let value: Record<string, unknown>;
    try {
      value = JSON.parse(jsonStr) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Failed to parse JSON value for key "${key}": ${(error as Error).message}`,
      );
    }

    entries.push({ key, value });
  }

  return entries;
}

function findEmbeddingVector(
  embeddings: unknown,
  modelKey: string,
): number[] | null {
  if (!embeddings || typeof embeddings !== 'object' || Array.isArray(embeddings)) {
    return null;
  }

  const embeddingsObj = embeddings as Record<string, unknown>;
  const matchingKey = Object.keys(embeddingsObj).find((k) => k.includes(modelKey));

  if (!matchingKey) return null;

  const entry = embeddingsObj[matchingKey] as { vec?: unknown } | undefined;
  if (!entry || !Array.isArray(entry.vec) || entry.vec.length === 0) return null;

  return entry.vec.map((v: unknown, i: number) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Non-numeric embedding value at index ${i}`);
    }
    return v;
  });
}

function extractBlockDefinitions(
  blocks: unknown,
  filePath: string,
): Array<{ heading: string; lines: [number, number] }> {
  if (blocks === undefined || blocks === null) return [];

  if (typeof blocks !== 'object' || Array.isArray(blocks)) {
    throw new Error(
      `Smart Connections file ${filePath} has an invalid blocks field (expected object)`,
    );
  }

  const result: Array<{ heading: string; lines: [number, number] }> = [];

  for (const [heading, lines] of Object.entries(blocks as Record<string, unknown>)) {
    if (
      !Array.isArray(lines) ||
      lines.length !== 2 ||
      typeof lines[0] !== 'number' ||
      typeof lines[1] !== 'number'
    ) {
      throw new Error(
        `Smart Connections file ${filePath} has an invalid block line range for heading "${heading}"`,
      );
    }
    result.push({ heading, lines: [lines[0], lines[1]] });
  }

  return result;
}

function parseSmartSourceEntry(
  entry: AjsonEntry,
  blockEmbeddings: Map<string, number[]>,
  modelKey: string,
  filePath: string,
): SmartSource | null {
  const value = entry.value;

  const notePath =
    typeof value.path === 'string' && value.path.trim() !== ''
      ? value.path.trim()
      : null;

  if (!notePath) {
    throw new Error(`Smart Connections file ${filePath} is missing a usable note path`);
  }

  const embedding = findEmbeddingVector(value.embeddings, modelKey);
  if (!embedding) {
    return null;
  }

  const normalizedPath = toPosixPath(notePath);
  const blockDefs = extractBlockDefinitions(value.blocks, filePath);

  const blocks: SmartBlock[] = blockDefs.map(({ heading, lines }) => {
    const fullKey = `${normalizedPath}${heading}`;
    const blockEmbedding = blockEmbeddings.get(fullKey) ?? [];
    return { key: fullKey, heading, lines, embedding: blockEmbedding };
  });

  return {
    path: normalizedPath,
    embedding,
    blocks,
  };
}

export async function loadSmartConnectionsCorpus(
  smartEnvPath: string,
  modelKey: string,
): Promise<SmartConnectionsCorpus> {
  let dirEntries: Dirent[];

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
    const content = await fs.readFile(filePath, 'utf8');

    let entries: AjsonEntry[];
    try {
      entries = parseAjsonContent(content);
    } catch (error) {
      throw new Error(
        `Failed to parse Smart Connections file ${filePath}: ${(error as Error).message}`,
      );
    }

    if (entries.length === 0) continue;

    const blockEmbeddings = new Map<string, number[]>();
    for (const entry of entries) {
      if (entry.key.startsWith('smart_blocks:')) {
        const blockKey = entry.key.slice('smart_blocks:'.length);
        const embedding = findEmbeddingVector(entry.value.embeddings, modelKey);
        if (embedding) {
          blockEmbeddings.set(blockKey, embedding);
        }
      }
    }

    for (const entry of entries) {
      if (!entry.key.startsWith('smart_sources:')) continue;

      const source = parseSmartSourceEntry(entry, blockEmbeddings, modelKey, filePath);

      if (!source) continue;

      sources.set(source.path, source);
    }
  }

  if (sources.size === 0) {
    throw new Error(`No usable Smart Connections notes were found in ${smartEnvPath}`);
  }

  getEmbeddingDimension(sources);

  return { sources };
}

export function summarizeSmartConnectionsCorpus(
  corpus: SmartConnectionsCorpus,
): SmartConnectionsCorpusStats {
  let totalBlocks = 0;

  for (const source of corpus.sources.values()) {
    totalBlocks += source.blocks.length;
  }

  const embeddingDimension = getEmbeddingDimension(corpus.sources);

  return {
    totalNotes: corpus.sources.size,
    totalBlocks,
    embeddingDimension,
  };
}

function getEmbeddingDimension(sources: Map<string, SmartSource>) {
  let expectedDimension: number | undefined;
  let expectedPath: string | undefined;

  for (const [sourcePath, source] of sources.entries()) {
    if (expectedDimension === undefined) {
      expectedDimension = source.embedding.length;
      expectedPath = sourcePath;
      continue;
    }

    if (source.embedding.length !== expectedDimension) {
      throw new Error(
        `Smart Connections corpus contains mixed embedding dimensions: ${expectedPath} has ${expectedDimension}, but ${sourcePath} has ${source.embedding.length}`,
      );
    }
  }

  return expectedDimension ?? 0;
}
