import path from 'node:path';

import { formatIdentity, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import { CorpusStore, isManifestCompatible } from '../src/lib/obsidian/corpus/shard-store.js';
import { loadCorpusSnapshot } from '../src/lib/obsidian/corpus/snapshot.js';
import type { SmartSource } from '../src/lib/obsidian/corpus/types.js';

export class BackendError extends Error {}

/** POSIX shell quoting: bare when safe, otherwise single-quoted (`'` → `'\''`). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./~+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The corpus the server owns, decoded — but only if it was built by the
 * profile this run embeds queries with. Eval never rebuilds (design D12).
 */
export async function loadSnapshot(
  vaultRoot: string,
  expected: CorpusIdentity,
): Promise<Map<string, SmartSource>> {
  const corpusDir = path.join(vaultRoot, '.neuro-vault/corpus');
  const rebuild = `neuro-vault-mcp index --vault ${shellQuote(vaultRoot)} --model ${expected.model_key}`;
  const store = new CorpusStore(vaultRoot, { dims: expected.dims });
  // Both refusals come before listing: shards of another width would each fail
  // validation loudly and decode to nothing, and vectors of another model can
  // share the width yet score as noise.
  const manifest = await store.readManifest();
  if (manifest === null && (await store.hasAnyShards())) {
    throw new BackendError(
      `own corpus at ${corpusDir} has no readable manifest — rebuild it with: ${rebuild}`,
    );
  }
  if (manifest !== null && !isManifestCompatible(manifest, expected, true)) {
    throw new BackendError(
      `own corpus at ${corpusDir} was indexed with ${formatIdentity(manifest)}, not ${formatIdentity(expected)} — rebuild it for this model with: ${rebuild}`,
    );
  }
  const snapshot = await loadCorpusSnapshot(store);
  if (snapshot.sources.size === 0) {
    throw new BackendError(
      `own corpus at ${corpusDir} is missing or empty — build it with: ${rebuild}`,
    );
  }
  return snapshot.sources;
}
