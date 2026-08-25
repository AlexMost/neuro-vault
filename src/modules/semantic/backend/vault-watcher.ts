import chokidar from 'chokidar';

/** A running watcher. `close()` is idempotent-safe and always awaited on shutdown. */
export interface WatcherHandle {
  close(): Promise<void>;
}

/** Builds the underlying watch. Production default: chokidar; tests inject a fake. */
export interface WatcherFactory {
  (opts: {
    vaultRoot: string;
    onChange: () => void;
    onError: (err: unknown) => void;
  }): WatcherHandle;
}

export interface VaultWatcherDeps {
  vaultRoot: string;
  vaultName: string;
  /** Fires ~debounceMs after the last change event. Wired to backend.requestReconcile. */
  onQuiet: () => void;
  debounceMs?: number;
  /** Defaults to a chokidar-backed watcher. */
  createWatcher?: WatcherFactory;
  /** Defaults to console.error — warnings must never touch stdout (the MCP transport). */
  warn?: (message: string) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export const DEBOUNCE_MS = 10_000;

/** Ignore dot-paths (including the server's own `.neuro-vault/corpus/` writes) and in-flight temp files. */
function isIgnoredPath(p: string): boolean {
  return /(^|[\\/])\../.test(p) || p.endsWith('.tmp');
}

function defaultCreateWatcher({
  vaultRoot,
  onChange,
  onError,
}: {
  vaultRoot: string;
  onChange: () => void;
  onError: (err: unknown) => void;
}): WatcherHandle {
  const watcher = chokidar.watch(vaultRoot, {
    ignored: isIgnoredPath,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 200 },
  });

  const forward = (path: string) => {
    if (path.endsWith('.md')) onChange();
  };

  watcher.on('add', forward);
  watcher.on('change', forward);
  watcher.on('unlink', forward);
  watcher.on('error', onError);

  return {
    close: () => watcher.close(),
  };
}

const noopHandle: WatcherHandle = {
  close: async () => {},
};

/**
 * Watches one vault root and coalesces its filesystem churn into a single
 * "quiet" signal (design D6). Any `.md` add/change/unlink event resets a
 * debounce timer; ~debounceMs after the last event, `onQuiet()` fires once.
 *
 * Dot-paths are always ignored — that is what stops the server's own writes
 * under `.neuro-vault/corpus/` from feeding this watcher back into itself.
 *
 * A watcher that fails to start, or errors later, degrades: it warns to
 * stderr and never throws. The vault simply keeps whatever corpus state it
 * had (reconcile-on-start) — the server keeps serving either way.
 */
export function startVaultWatcher(deps: VaultWatcherDeps): WatcherHandle {
  const {
    vaultRoot,
    vaultName,
    onQuiet,
    debounceMs = DEBOUNCE_MS,
    createWatcher = defaultCreateWatcher,
    warn = (message: string) => console.error(message),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = deps;

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleQuiet = () => {
    if (closed) return;
    if (timer !== undefined) clearTimer(timer);
    timer = setTimer(() => {
      timer = undefined;
      onQuiet();
    }, debounceMs);
  };

  const onError = (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[semantic] vault watcher error for "${vaultName}": ${reason}`);
  };

  let handle: WatcherHandle;
  try {
    handle = createWatcher({ vaultRoot, onChange: scheduleQuiet, onError });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`[semantic] vault watcher failed to start for "${vaultName}": ${reason}`);
    return noopHandle;
  }

  return {
    close: async () => {
      closed = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      await handle.close();
    },
  };
}
