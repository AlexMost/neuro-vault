import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isIgnoredPath,
  isMarkdownPath,
  startVaultWatcher,
} from '../../../src/modules/semantic/backend/vault-watcher.js';

function fakeWatcherFactory() {
  const handles: Array<{ fire: () => void; fail: (e: unknown) => void; closed: boolean }> = [];
  const factory = ({
    onChange,
    onError,
  }: {
    onChange: () => void;
    onError: (e: unknown) => void;
  }) => {
    const handle = {
      fire: onChange,
      fail: onError,
      closed: false,
      close: async () => {
        handle.closed = true;
      },
    };
    handles.push(handle);
    return handle;
  };
  return { factory, handles };
}

describe('isIgnoredPath', () => {
  it("ignores the server's own corpus writes under the vault root", () => {
    expect(isIgnoredPath('/vault', '/vault/.neuro-vault/corpus/x.json')).toBe(true);
  });

  it('does not ignore an ordinary note under the vault root', () => {
    expect(isIgnoredPath('/vault', '/vault/notes/a.md')).toBe(false);
  });

  it('does not ignore a vault nested under an unrelated dot-directory', () => {
    expect(isIgnoredPath('/Users/x/.sync/vault', '/Users/x/.sync/vault/notes/a.md')).toBe(false);
  });

  it('ignores an in-flight temp file inside the vault', () => {
    expect(isIgnoredPath('/vault', '/vault/notes/a.md.tmp')).toBe(true);
  });

  it('does not ignore the vault root itself', () => {
    expect(isIgnoredPath('/vault', '/vault')).toBe(false);
  });
});

describe('isMarkdownPath', () => {
  it('accepts .md paths', () => {
    expect(isMarkdownPath('/vault/notes/a.md')).toBe(true);
  });

  it('rejects non-.md paths', () => {
    expect(isMarkdownPath('/vault/notes/a.txt')).toBe(false);
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

  it('warns and stays quiet when the watcher cannot start', () => {
    const warn = vi.fn();
    const onQuiet = vi.fn();
    startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
      warn,
      createWatcher: () => {
        throw new Error('EMFILE');
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EMFILE'));
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
      warn,
      createWatcher: factory,
    });
    handles[0].fail(new Error('ENOSPC'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENOSPC'));
  });

  it('close cancels a pending debounce and closes the watcher', async () => {
    const onQuiet = vi.fn();
    const { factory, handles } = fakeWatcherFactory();
    const handle = startVaultWatcher({
      vaultRoot: '/v',
      vaultName: 'v',
      onQuiet,
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
      warn,
      createWatcher: factory,
      debounceMs: 100,
    });

    handles[0].fire();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
