import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVaultScope } from '../../../src/lib/obsidian/vault-scope.js';
import {
  isPrunedDir,
  isWatchedNote,
  startVaultWatcher,
  vaultRelative,
} from '../../../src/lib/vault-entry/watcher.js';

const scope = createVaultScope({ configExclusions: ['Archive'] });
const oneLevelScope = createVaultScope({ configExclusions: ['Archive/*'] });

function fakeWatcherFactory() {
  const handles: Array<{
    fire: () => void;
    fail: (e: unknown) => void;
    closed: boolean;
    scope: unknown;
  }> = [];
  const factory = ({
    onChange,
    onError,
    scope,
  }: {
    onChange: () => void;
    onError: (e: unknown) => void;
    scope: unknown;
  }) => {
    const handle = {
      fire: onChange,
      fail: onError,
      closed: false,
      scope,
      close: async () => {
        handle.closed = true;
      },
    };
    handles.push(handle);
    return handle;
  };
  return { factory, handles };
}

describe('vaultRelative', () => {
  it('judges a path relative to the vault root with / separators', () => {
    expect(vaultRelative('/vault', '/vault/Archive/n.md')).toBe('Archive/n.md');
  });

  it('converts Windows separators', () => {
    expect(vaultRelative('C:\\vault', 'C:\\vault\\Archive\\n.md')).toBe('Archive/n.md');
  });

  it('returns an empty string for the root itself', () => {
    expect(vaultRelative('/vault', '/vault')).toBe('');
  });
});

describe('isWatchedNote', () => {
  it('accepts an in-scope .md', () => {
    expect(isWatchedNote(scope, '/vault', '/vault/Notes/a.md')).toBe(true);
  });

  it('rejects a .md under an excluded subtree', () => {
    expect(isWatchedNote(scope, '/vault', '/vault/Archive/a.md')).toBe(false);
  });

  it('rejects a non-.md path', () => {
    expect(isWatchedNote(scope, '/vault', '/vault/Notes/a.txt')).toBe(false);
  });

  it('rejects a .md under a dot directory', () => {
    expect(isWatchedNote(scope, '/vault', '/vault/Notes/.trash/x.md')).toBe(false);
  });

  it("ignores the server's own corpus writes", () => {
    expect(isWatchedNote(scope, '/vault', '/vault/.neuro-vault/corpus/x.md')).toBe(false);
  });

  it('keeps a note two levels under a one-level glob', () => {
    expect(isWatchedNote(oneLevelScope, '/vault', '/vault/Archive/2024/x.md')).toBe(true);
  });

  it('judges a Windows path as its vault-relative form', () => {
    expect(isWatchedNote(scope, 'C:\\vault', 'C:\\vault\\Archive\\note.md')).toBe(false);
  });
});

describe('isPrunedDir', () => {
  it('prunes a provably excluded subtree', () => {
    expect(isPrunedDir(scope, '/vault', '/vault/Archive')).toBe(true);
    expect(isPrunedDir(scope, '/vault', '/vault/Archive/2024')).toBe(true);
  });

  it('prunes a dot directory inside the vault', () => {
    expect(isPrunedDir(scope, '/vault', '/vault/.neuro-vault')).toBe(true);
  });

  it('does not prune a one-level glob, whose deeper notes stay in scope', () => {
    expect(isPrunedDir(oneLevelScope, '/vault', '/vault/Archive')).toBe(false);
    expect(isPrunedDir(oneLevelScope, '/vault', '/vault/Archive/2024')).toBe(false);
  });

  it('does not prune an ordinary directory', () => {
    expect(isPrunedDir(scope, '/vault', '/vault/Notes')).toBe(false);
  });

  it('never prunes the vault root', () => {
    expect(isPrunedDir(scope, '/vault', '/vault')).toBe(false);
  });

  it('does not prune a vault nested under an unrelated dot-directory', () => {
    const root = '/home/u/.sync/vault';
    expect(isPrunedDir(scope, root, root)).toBe(false);
    expect(isPrunedDir(scope, root, `${root}/Notes`)).toBe(false);
    expect(isPrunedDir(scope, root, `${root}/Archive`)).toBe(true);
  });
});

describe('startVaultWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls onQuiet once after a burst settles', () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      createWatcher: factory,
      debounceMs: 100,
    });
    handles[0].fire();
    vi.advanceTimersByTime(50);
    handles[0].fire();
    vi.advanceTimersByTime(50);
    expect(onQuiet).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onQuiet).toHaveBeenCalledTimes(1);
  });

  it('hands the scope to the watcher factory', () => {
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet: vi.fn(),
      scope,
      createWatcher: factory,
    });
    expect(handles[0].scope).toBe(scope);
  });

  it('warns and stays quiet when the watcher cannot start', () => {
    const warn = vi.fn();
    const onQuiet = vi.fn();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      warn,
      createWatcher: () => {
        throw new Error('EMFILE');
      },
    });
    expect(warn).toHaveBeenCalledWith('neuro-vault watcher: vault "v": failed to start: EMFILE');
    vi.advanceTimersByTime(60_000);
    expect(onQuiet).not.toHaveBeenCalled();
  });

  it('warns on a later watcher error without throwing', () => {
    const warn = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet: vi.fn(),
      scope,
      warn,
      createWatcher: factory,
    });
    handles[0].fail(new Error('ENOSPC'));
    expect(warn).toHaveBeenCalledWith('neuro-vault watcher: vault "v": ENOSPC');
  });

  it('close cancels a pending debounce and closes the watcher', async () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    const handle = startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      createWatcher: factory,
      debounceMs: 100,
    });
    handles[0].fire();
    await handle.close();
    vi.advanceTimersByTime(1_000);
    expect(onQuiet).not.toHaveBeenCalled();
    expect(handles[0].closed).toBe(true);
  });

  it('re-arms after firing onQuiet, so a later burst fires it again', () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      createWatcher: factory,
      debounceMs: 100,
    });

    handles[0].fire();
    vi.advanceTimersByTime(100);
    expect(onQuiet).toHaveBeenCalledTimes(1);

    handles[0].fire();
    vi.advanceTimersByTime(100);
    expect(onQuiet).toHaveBeenCalledTimes(2);
  });

  it('threads a custom setTimer/clearTimer through scheduling and cancellation', async () => {
    const scheduled: Array<{ cb: () => void; delay: number }> = [];
    let nextId = 0;
    const setTimer = vi.fn((cb: () => void, delay: number) => {
      scheduled.push({ cb, delay });
      return ++nextId as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    const handle = startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      createWatcher: factory,
      debounceMs: 100,
      setTimer: setTimer as unknown as typeof setTimeout,
      clearTimer,
    });

    handles[0].fire();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(scheduled[0].delay).toBe(100);

    scheduled[0].cb();
    expect(onQuiet).toHaveBeenCalledTimes(1);

    handles[0].fire();
    expect(setTimer).toHaveBeenCalledTimes(2);

    await handle.close();
    expect(clearTimer).toHaveBeenCalledWith(2);
  });

  it('warns instead of throwing when onQuiet itself throws', () => {
    const warn = vi.fn();
    const onQuiet = vi.fn(() => {
      throw new Error('boom');
    });
    const { factory, handles } = fakeWatcherFactory();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      scope,
      warn,
      createWatcher: factory,
      debounceMs: 100,
    });

    handles[0].fire();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
