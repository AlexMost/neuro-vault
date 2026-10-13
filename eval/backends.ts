import path from 'node:path';

import { formatIdentity, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import { CorpusStore, isManifestCompatible } from '../src/lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../src/lib/obsidian/corpus/snapshot.js';
import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';

export class BackendError extends Error {}

export async function loadSnapshot(
  vaultRoot: string,
  identity: CorpusIdentity,
): Promise<Map<string, SmartSource>> {
  const store = new CorpusStore(vaultRoot, { dims: identity.dims });
  const snapshot = await loadCorpusSnapshot(store);
  // Vectors of another model can share the dims and still decode; scoring
  // them against this model's queries would report noise as a result.
  const manifest = snapshot.sources.size > 0 ? await store.readManifest() : null;
  if (snapshot.sources.size > 0 && !isManifestCompatible(manifest, identity, true)) {
    throw new BackendError(
      `own corpus at ${path.join(vaultRoot, '.neuro-vault/corpus')} was indexed with ` +
        `${formatIdentity(manifest)}; the eval queries with ${formatIdentity(identity)} — ` +
        'rebuild it with: neuro-vault-mcp index --vault <path>',
    );
  }
  if (snapshot.sources.size === 0) {
    throw new BackendError(
      `own corpus at ${path.join(vaultRoot, '.neuro-vault/corpus')} is missing or empty — ` +
        'build it with: neuro-vault-mcp index --vault <path>',
    );
  }
  return snapshot.sources;
}
