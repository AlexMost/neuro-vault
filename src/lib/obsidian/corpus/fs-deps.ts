import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { VaultReader } from '../vault-reader.js';
import type { NoteContent, NoteStat, ReconcileDeps } from './reconcile.js';

/** The filesystem half of {@link ReconcileDeps} — everything but `embed` and `store`. */
export type ReconcileFsDeps = Pick<ReconcileDeps, 'vaultRoot' | 'scan' | 'stat' | 'readNote'>;

/**
 * Binds `reconcileCorpus`'s filesystem access to one vault: membership from the
 * reader's scope-filtered scan, metadata and content from `node:fs`.
 *
 * Both reconcile call sites — the `neuro-vault-mcp index` CLI and the server's
 * own-corpus backend — build their deps here, so the two cannot disagree about
 * what a note's `mtime` and `size` are. That matters: `mtime`/`size` are the
 * pre-check that decides whether a note is re-read at all, so a CLI run and a
 * server pass reading them differently would keep re-embedding each other's
 * notes.
 */
export function buildReconcileFsDeps(opts: {
  vaultRoot: string;
  reader: VaultReader;
}): ReconcileFsDeps {
  const { vaultRoot, reader } = opts;
  return {
    vaultRoot,
    scan: () => reader.scan(),
    stat: async (relPath: string): Promise<NoteStat> => {
      const s = await stat(path.join(vaultRoot, relPath));
      return { mtime: s.mtimeMs, size: s.size };
    },
    readNote: async (relPath: string): Promise<NoteContent> => {
      const abs = path.join(vaultRoot, relPath);
      const s = await stat(abs);
      const content = await readFile(abs, 'utf8');
      return { content, mtime: s.mtimeMs, size: s.size };
    },
  };
}
