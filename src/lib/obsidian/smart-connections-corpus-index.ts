import fs from 'node:fs/promises';
import path from 'node:path';

import { buildBasenameIndex, type BasenameIndex } from './link-resolver.js';
import {
  loadSmartConnectionsCorpus as defaultLoadCorpus,
  type SmartConnectionsCorpus,
} from './smart-connections-loader.js';
import type { SmartSource } from './smart-connections-types.js';

export type LoadCorpusFn = (
  smartEnvPath: string,
  modelKey: string,
) => Promise<SmartConnectionsCorpus>;

export interface CreateSmartConnectionsCorpusIndexOptions {
  smartEnvPath: string;
  modelKey: string;
  loadCorpus?: LoadCorpusFn;
}

export interface SmartConnectionsCorpusIndex {
  ensureFresh(): Promise<void>;
  getSources(): Map<string, SmartSource>;
  getBasenameIndex(): BasenameIndex;
}

interface DirectorySignature {
  maxMtimeMs: number;
  fileCount: number;
}

async function readSignature(smartEnvPath: string): Promise<DirectorySignature> {
  const entries = await fs.readdir(smartEnvPath, { withFileTypes: true });
  const ajson = entries.filter((e) => e.isFile() && e.name.endsWith('.ajson'));
  if (ajson.length === 0) {
    return { maxMtimeMs: 0, fileCount: 0 };
  }
  const stats = await Promise.all(ajson.map((e) => fs.stat(path.join(smartEnvPath, e.name))));
  let maxMtimeMs = 0;
  for (const s of stats) {
    if (s.mtimeMs > maxMtimeMs) maxMtimeMs = s.mtimeMs;
  }
  return { maxMtimeMs, fileCount: ajson.length };
}

function signaturesEqual(a: DirectorySignature, b: DirectorySignature): boolean {
  return a.maxMtimeMs === b.maxMtimeMs && a.fileCount === b.fileCount;
}

export async function createSmartConnectionsCorpusIndex(
  opts: CreateSmartConnectionsCorpusIndexOptions,
): Promise<SmartConnectionsCorpusIndex> {
  const loadCorpus = opts.loadCorpus ?? defaultLoadCorpus;

  let sources: Map<string, SmartSource>;
  let basenameIndex: BasenameIndex;
  let signature: DirectorySignature;

  const initial = await loadCorpus(opts.smartEnvPath, opts.modelKey);
  sources = initial.sources;
  basenameIndex = buildBasenameIndex(sources.keys());
  signature = await readSignature(opts.smartEnvPath);

  async function ensureFresh(): Promise<void> {
    const current = await readSignature(opts.smartEnvPath);
    if (signaturesEqual(current, signature)) return;

    const next = await loadCorpus(opts.smartEnvPath, opts.modelKey);
    const nextBasename = buildBasenameIndex(next.sources.keys());
    sources = next.sources;
    basenameIndex = nextBasename;
    signature = current;
  }

  return {
    ensureFresh,
    getSources: () => sources,
    getBasenameIndex: () => basenameIndex,
  };
}
