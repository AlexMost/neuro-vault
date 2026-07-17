import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { vi } from 'vitest';

import { FsVaultReader } from '../../../src/lib/obsidian/vault-reader.js';
import type { WikilinkGraphIndex } from '../../../src/lib/obsidian/wikilink-graph.js';
import { FsVaultProvider } from '../../../src/modules/operations/fs-vault-provider.js';

/** Create a temp vault seeded with the given `{ vault-relative-path: contents }` map. */
export async function makeVault(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fs-provider-'));
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, 'utf8');
  }
  return root;
}

/** Build an FsVaultProvider backed by a real FsVaultReader over `root`. */
export function makeProvider(root: string): FsVaultProvider {
  return new FsVaultProvider({ vaultRoot: root, reader: new FsVaultReader({ vaultRoot: root }) });
}

/** A stub WikilinkGraphIndex for `computeVaultOverview` integration tests. */
export function makeMockGraph(): WikilinkGraphIndex {
  return {
    ensureFresh: vi.fn().mockResolvedValue(undefined),
    getNoteLinks: vi.fn(() => ({ incoming: [], outgoing: [] })),
    getBacklinkCount: vi.fn(() => 0),
  } as unknown as WikilinkGraphIndex;
}

/** Today's basename in the default `YYYY-MM-DD` daily-note format (local time, timezone-safe). */
export function todayBasename(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${day}`;
}

/** A `kind: 'path'` note identifier. */
export const byPath = (p: string) => ({ kind: 'path' as const, value: p });

/** A `kind: 'name'` note identifier. */
export const byName = (n: string) => ({ kind: 'name' as const, value: n });
