import { readFile as fsReadFile, rename as fsRename, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { ensureCorpusDir, type MkdirFn } from './ensure-dir.js';
import { hasErrnoCode } from './errno.js';
import { isStoredManifest } from './identity.js';
import {
  CORPUS_DIR,
  corpusRootOf,
  metaDirOf,
  isModelDirName,
  LEGACY_MANIFEST_FILE,
  LEGACY_NOTES_DIR,
} from './layout.js';

export type LegacyMigration =
  | { kind: 'none' }
  | { kind: 'migrated'; modelKey: string }
  | { kind: 'skipped'; reason: 'unreadable' | 'target-exists' };

export interface LegacyMigrationDeps {
  readFile?: (p: string) => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
  mkdir?: MkdirFn;
  exists?: (p: string) => Promise<boolean>;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
}

/**
 * Moves a single-corpus layout — `manifest.json` and `notes/` directly under
 * `.neuro-vault/corpus/` — into `.neuro-vault/corpus/<model_key>/`, taking the
 * key from that manifest (design D3). Renames, never copies or re-embeds.
 *
 * Keyed on the target's manifest, and the manifest moves last: a migration
 * interrupted between the two renames leaves the root manifest behind and the
 * target without one, and the next call completes it. A target that already
 * has a manifest is left alone, as is a legacy manifest that does not parse or
 * names an unsafe key — `index --prune` removes either. Callers hold the
 * vault's reconcile lock (design D4), so two processes never race the renames;
 * a source that vanished anyway is "already moved", never an error.
 */
export async function migrateLegacyCorpus(
  vaultRoot: string,
  deps: LegacyMigrationDeps = {},
): Promise<LegacyMigration> {
  const readFile = deps.readFile ?? ((p: string) => fsReadFile(p, 'utf8'));
  const rename = deps.rename ?? ((from: string, to: string) => fsRename(from, to));
  const exists = deps.exists ?? pathExists;
  const warn = deps.warn ?? ((message: string) => console.error(message));

  const root = corpusRootOf(vaultRoot);
  const legacyManifest = path.join(root, LEGACY_MANIFEST_FILE);

  let raw: string;
  try {
    raw = await readFile(legacyManifest);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return { kind: 'none' };
    return { kind: 'skipped', reason: 'unreadable' };
  }

  // Not warned: this runs on every pass, and an unreadable leftover would
  // repeat the line on every debounced tick.
  const modelKey = legacyModelKey(raw);
  if (modelKey === null) return { kind: 'skipped', reason: 'unreadable' };

  const target = path.join(root, modelKey);
  if (await exists(path.join(target, LEGACY_MANIFEST_FILE))) {
    return { kind: 'skipped', reason: 'target-exists' };
  }

  await ensureCorpusDir(metaDirOf(vaultRoot), target, deps.mkdir);
  if (!(await exists(path.join(target, LEGACY_NOTES_DIR)))) {
    await renameIfPresent(
      rename,
      path.join(root, LEGACY_NOTES_DIR),
      path.join(target, LEGACY_NOTES_DIR),
    );
  }
  await renameIfPresent(rename, legacyManifest, path.join(target, LEGACY_MANIFEST_FILE));
  warn(
    `neuro-vault corpus: moved the ${modelKey} corpus of vault ${vaultRoot} into ` +
      `${CORPUS_DIR}/${modelKey}/ (one corpus directory per model)`,
  );
  return { kind: 'migrated', modelKey };
}

/** The legacy manifest's model key, or null when it does not parse or is unsafe as a path segment. */
function legacyModelKey(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredManifest(parsed)) return null;
  return isModelDirName(parsed.model_key) ? parsed.model_key : null;
}

async function renameIfPresent(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return;
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsStat(p);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, 'ENOENT')) return false;
    throw err;
  }
}
