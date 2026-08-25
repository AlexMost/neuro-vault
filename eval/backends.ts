import path from 'node:path';

import { CorpusStore } from '../src/lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../src/lib/obsidian/corpus/snapshot.js';
import { MODEL_KEY } from '../src/lib/obsidian/corpus/types.js';
import { createSmartConnectionsCorpusIndex } from '../src/lib/obsidian/smart-connections-corpus-index.js';
import type { SmartSource } from '../src/lib/obsidian/smart-connections-types.js';

export type BackendId = 'sc' | 'own';

export class BackendError extends Error {}

async function loadOwn(vaultRoot: string): Promise<Map<string, SmartSource>> {
  const snapshot = await loadCorpusSnapshot(new CorpusStore(vaultRoot));
  if (snapshot.sources.size === 0) {
    throw new BackendError(
      `own corpus at ${path.join(vaultRoot, '.neuro-vault/corpus')} is missing or empty — ` +
        'build it with: neuro-vault-mcp index --vault <path>',
    );
  }
  return snapshot.sources;
}

// How to produce an `sc` corpus. The spec requires every backend-loading
// failure to name the missing corpus AND the remedy, so this rides on the
// wrapped `catch` message below — the only message a real `sc` failure prints.
const SC_REMEDY = 'open the vault in Obsidian with Smart Connections installed';

async function loadSc(vaultRoot: string): Promise<Map<string, SmartSource>> {
  const smartEnvPath = path.join(vaultRoot, '.smart-env', 'multi');
  let sources: Map<string, SmartSource>;
  try {
    const index = await createSmartConnectionsCorpusIndex({ smartEnvPath, modelKey: MODEL_KEY });
    ({ sources } = await index.snapshot());
  } catch (error) {
    throw new BackendError(
      `failed to load the Smart Connections corpus at ${smartEnvPath}: ` +
        `${error instanceof Error ? error.message : String(error)} — ${SC_REMEDY}`,
    );
  }
  // Defensive only: the loader already throws both for a missing directory
  // and for a corpus holding no usable notes, so control does not reach here
  // today. Kept so a loader that ever returns an empty map still fails loudly
  // rather than scoring every query against nothing.
  if (sources.size === 0) {
    throw new BackendError(`Smart Connections corpus at ${smartEnvPath} is empty — ${SC_REMEDY}`);
  }
  return sources;
}

export async function loadSnapshot(
  backend: BackendId,
  vaultRoot: string,
): Promise<Map<string, SmartSource>> {
  return backend === 'own' ? loadOwn(vaultRoot) : loadSc(vaultRoot);
}
