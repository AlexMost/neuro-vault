import { formatIdentity, type CorpusIdentity } from '../src/lib/obsidian/corpus/identity.js';
import { modelCorpusDir } from '../src/lib/obsidian/corpus/layout.js';
import { listModelCorpora } from '../src/lib/obsidian/corpus/prune.js';
import { ShardCorpus } from '../src/lib/obsidian/corpus/shard-corpus.js';
import { ShardStore, isManifestCompatible } from '../src/lib/obsidian/corpus/shard-store.js';

export class BackendError extends Error {}

/** POSIX shell quoting: bare when safe, otherwise single-quoted (`'` → `'\''`). */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./~+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The selected model's corpus the server owns, loaded in-process (design D15) — but only if
 * it was built by the profile this run embeds queries with. Eval never builds, migrates,
 * locks or deletes a corpus (design D10), so evaluating one model leaves every model's
 * corpus as it found it. Like the decode it replaced, it ranks every note the corpus holds:
 * the vault's scope is not applied.
 */
export async function loadCorpus(
  vaultRoot: string,
  expected: CorpusIdentity,
): Promise<ShardCorpus> {
  const corpusDir = modelCorpusDir(vaultRoot, expected.model_key);
  const rebuild = `neuro-vault-mcp index --vault ${shellQuote(vaultRoot)} --model ${expected.model_key}`;
  const store = new ShardStore(vaultRoot, { modelKey: expected.model_key, dims: expected.dims });
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
  const corpus = new ShardCorpus(store);
  await corpus.load();
  if (corpus.size() === 0) {
    // Another model's corpus is the usual reason, and naming it says so.
    const others = (await listModelCorpora(vaultRoot)).filter((key) => key !== expected.model_key);
    const present =
      others.length === 0 ? '' : ` (this vault has corpora for: ${others.join(', ')})`;
    throw new BackendError(
      `own corpus at ${corpusDir} is missing or empty${present} — build it with: ${rebuild}`,
    );
  }
  return corpus;
}

/** The notes `corpus` holds a vector for: the ones that rank. */
export async function notesWithVectors(corpus: ShardCorpus): Promise<string[]> {
  return [...(await corpus.entries()).keys()].filter((p) => corpus.vectorOf(p) !== null);
}
