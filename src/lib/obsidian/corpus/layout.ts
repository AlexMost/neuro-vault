import path from 'node:path';

/** The server's own directory at the vault root; the corpus (and the vault's config) live in it. */
export const META_DIR = '.neuro-vault';

/** Corpus root, relative to the vault root. Each model's corpus is a directory under it. */
export const CORPUS_DIR = `${META_DIR}/corpus`;

/**
 * The shard directory and manifest of the single-corpus layout that preceded
 * per-model directories, directly under the corpus root (design D3).
 */
export const LEGACY_NOTES_DIR = 'notes';
export const LEGACY_MANIFEST_FILE = 'manifest.json';

/** The cross-process reconcile lock, one per vault, beside the model directories (design D5). */
export const LOCK_FILE = 'reconcile.lock';

/**
 * Entries the corpus root keeps for itself, lower-cased. A model directory
 * named after one would alias it — `Notes` is `notes` on a case-insensitive
 * filesystem — or make migration stat through a file (design D2).
 */
export const RESERVED_ROOT_NAMES: ReadonlySet<string> = new Set([
  LEGACY_NOTES_DIR,
  LEGACY_MANIFEST_FILE,
  LOCK_FILE,
]);

/**
 * One path segment, never `.`/`..` or a dot-directory, never a reserved root
 * entry. A legacy manifest's `model_key` is data read off disk and becomes a
 * path segment during migration, so it is checked like any other input.
 */
const MODEL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isModelDirName(name: string): boolean {
  return MODEL_DIR_RE.test(name) && !RESERVED_ROOT_NAMES.has(name.toLowerCase());
}

/** `<vaultRoot>/.neuro-vault`. */
export function metaDirOf(vaultRoot: string): string {
  return path.join(vaultRoot, META_DIR);
}

/** `<vaultRoot>/.neuro-vault/corpus` — holds every model's directory and the reconcile lock. */
export function corpusRootOf(vaultRoot: string): string {
  return path.join(vaultRoot, CORPUS_DIR);
}

/** `<vaultRoot>/.neuro-vault/corpus/<modelKey>` (design D1). Throws on a name {@link isModelDirName} rejects. */
export function modelCorpusDir(vaultRoot: string, modelKey: string): string {
  if (!isModelDirName(modelKey)) {
    throw new Error(`neuro-vault corpus: "${modelKey}" is not a valid model directory name`);
  }
  return path.join(corpusRootOf(vaultRoot), modelKey);
}
