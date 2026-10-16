import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import { startVaultWatcher, type WatcherHandle } from '../../../src/lib/vault-entry/watcher.js';

// The default factory's awaitWriteFinish holds an event back until the file has
// been stable for 2 s, so a positive event takes more than that to arrive.
const AWAIT_WRITE_FINISH_MS = 2_000;
const NEGATIVE_WINDOW_MS = AWAIT_WRITE_FINISH_MS + 1_500;
const POSITIVE_DEADLINE_MS = 8_000;
const TEST_TIMEOUT_MS = 20_000;

async function waitFor(condition: () => boolean, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe('startVaultWatcher over a real chokidar watcher', () => {
  let root: string;
  let handle: WatcherHandle | undefined;
  let chokidarWatcher: FSWatcher;

  beforeEach(async () => {
    // realpath: macOS tmpdir is a symlink, and chokidar reports resolved paths.
    root = await realpath(await mkdtemp(join(tmpdir(), 'nv-watcher-')));
    await mkdir(join(root, 'Archive'));
    await mkdir(join(root, 'Notes'));
  });

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  // Starts the production default factory and waits for chokidar's initial scan
  // to finish. The watcher instance is observed by spying on `chokidar.watch`
  // rather than by widening WatcherHandle with a readiness hook only a test uses.
  async function start(onQuiet: () => void): Promise<void> {
    const watch = vi.spyOn(chokidar, 'watch');
    handle = startVaultWatcher({
      vaultRoot: root,
      vaultName: 'v',
      onQuiet,
      scope: createVaultScope({ configExclusions: ['Archive'] }),
      debounceMs: 50,
    });
    chokidarWatcher = watch.mock.results[0].value as FSWatcher;
    await new Promise<void>((resolve) => chokidarWatcher.once('ready', () => resolve()));
  }

  it(
    'schedules nothing for an excluded subtree, never walks it, and fires for an in-scope note',
    async () => {
      const onQuiet = vi.fn();
      await start(onQuiet);

      // The excluded subtree was pruned during the initial scan, not just filtered.
      expect(Object.keys(chokidarWatcher.getWatched())).not.toContain(join(root, 'Archive'));
      expect(Object.keys(chokidarWatcher.getWatched())).toContain(join(root, 'Notes'));

      await writeFile(join(root, 'Archive', 'a.md'), 'excluded');
      await new Promise((resolve) => setTimeout(resolve, NEGATIVE_WINDOW_MS));
      expect(onQuiet).not.toHaveBeenCalled();

      await writeFile(join(root, 'Notes', 'b.md'), 'in scope');
      expect(await waitFor(() => onQuiet.mock.calls.length > 0, POSITIVE_DEADLINE_MS)).toBe(true);
      expect(onQuiet).toHaveBeenCalledTimes(1);
    },
    TEST_TIMEOUT_MS,
  );
});
