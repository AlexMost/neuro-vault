import path from 'node:path';

import { CorpusStore } from '../src/lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../src/lib/obsidian/corpus/snapshot.js';
import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';

export class BackendError extends Error {}

export async function loadSnapshot(vaultRoot: string): Promise<Map<string, SmartSource>> {
  const snapshot = await loadCorpusSnapshot(new CorpusStore(vaultRoot));
  if (snapshot.sources.size === 0) {
    throw new BackendError(
      `own corpus at ${path.join(vaultRoot, '.neuro-vault/corpus')} is missing or empty — ` +
        'build it with: neuro-vault-mcp index --vault <path>',
    );
  }
  return snapshot.sources;
}
