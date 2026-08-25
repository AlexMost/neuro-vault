import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startVaultWatcher } from '../../../src/modules/semantic/backend/vault-watcher.js';

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
});
