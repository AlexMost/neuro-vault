import { readdir as fsReaddir, rm as fsRm, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { hasErrnoCode } from './errno.js';
import { corpusRootOf, isModelDirName, LEGACY_MANIFEST_FILE } from './layout.js';

export interface CorpusEntry {
  name: string;
  /** False for a symlink, even one pointing at a directory — prune never follows links. */
  isDirectory: boolean;
}

export interface PruneDeps {
  list?: (dir: string) => Promise<CorpusEntry[]>;
  remove?: (p: string) => Promise<void>;
  /** Whether a path exists; defaults to `stat`, with `ENOENT` meaning no. */
  exists?: (p: string) => Promise<boolean>;
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return false;
    throw err;
  }
}

async function defaultList(dir: string): Promise<CorpusEntry[]> {
  const entries = await fsReaddir(dir, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
}

async function listCorpusRoot(
  vaultRoot: string,
  list: (dir: string) => Promise<CorpusEntry[]>,
): Promise<CorpusEntry[]> {
  try {
    return await list(corpusRootOf(vaultRoot));
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return [];
    throw err;
  }
}

/** The model corpora present under a vault, sorted — for naming them, never for deciding what to delete. */
export async function listModelCorpora(vaultRoot: string, deps: PruneDeps = {}): Promise<string[]> {
  const entries = await listCorpusRoot(vaultRoot, deps.list ?? defaultList);
  return entries
    .filter((entry) => entry.isDirectory && isModelDirName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Deletes every directory directly under the corpus root except
 * `keepModelKey`'s — other models' corpora and a leftover legacy `notes/` —
 * plus a legacy root `manifest.json` (design D8). Leaves the reconcile lock and
 * every other file. Returns what it removed, sorted. The caller holds the
 * vault's reconcile lock, so no other process is mid-pass in what goes.
 *
 * Refuses, removing nothing, unless `keepModelKey`'s corpus has a manifest: a
 * concurrent prune by another model, between this run's reconcile and its
 * prune, may have removed it, and pruning then would leave nothing to serve.
 */
export async function pruneOtherCorpora(
  vaultRoot: string,
  keepModelKey: string,
  deps: PruneDeps = {},
): Promise<string[]> {
  const remove = deps.remove ?? ((p: string) => fsRm(p, { recursive: true, force: true }));
  const exists = deps.exists ?? defaultExists;
  if (!isModelDirName(keepModelKey)) {
    throw new Error(
      `neuro-vault corpus: not pruning ${vaultRoot}: "${keepModelKey}" is not a valid model ` +
        `directory name`,
    );
  }
  if (!(await exists(path.join(corpusRootOf(vaultRoot), keepModelKey, 'manifest.json')))) {
    throw new Error(
      `neuro-vault corpus: not pruning ${vaultRoot}: the ${keepModelKey} corpus has no manifest, ` +
        `so nothing would be left to serve`,
    );
  }
  const entries = await listCorpusRoot(vaultRoot, deps.list ?? defaultList);
  const doomed = entries
    .filter((entry) =>
      entry.isDirectory ? entry.name !== keepModelKey : entry.name === LEGACY_MANIFEST_FILE,
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of doomed) {
    await remove(path.join(corpusRootOf(vaultRoot), name));
  }
  return doomed;
}
