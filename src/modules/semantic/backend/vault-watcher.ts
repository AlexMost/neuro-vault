import { relative } from 'node:path';

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

/**
 * Ignore dot-paths and in-flight temp files, judged relative to the vault
 * root — not the absolute path chokidar hands the `ignored` predicate.
 *
 * chokidar passes absolute paths throughout (the root itself, then each
 * entry as `join(watchPath, relative(watchPath, entry.fullPath))`), so
 * testing the absolute path against `/(^|[\\/])\../ ` matches any dot
 * segment *above* the vault root too — a vault living under a dot-directory
 * (e.g. `~/.sync/vault`) would then have every path ignored and the watcher
 * would silently never fire. Matching on `relative(vaultRoot, p)` scopes the
 * rule to paths *inside* the vault, which is what stops the server's own
 * writes under `.neuro-vault/corpus/` from feeding this watcher back into
 * itself (design D6) without also blinding the watcher for vaults nested
 * under an unrelated dot-directory.
 */
export function isIgnoredPath(vaultRoot: string, p: string): boolean {
  const rel = relative(vaultRoot, p);
  if (rel === '') return false; // the vault root itself is never ignored
  return /(^|[\\/])\../.test(rel) || rel.endsWith('.tmp');
}

/**
 * `ignored` only filters dot-segments and `.tmp` suffixes (see
 * {@link isIgnoredPath}) — it does not filter by extension, so this is the
 * only thing keeping non-`.md` churn (e.g. a stray `.txt` add) out of
 * `onChange`.
 */
export function isMarkdownPath(p: string): boolean {
  return p.endsWith('.md');
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
    ignored: (p: string) => isIgnoredPath(vaultRoot, p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 200 },
  });

  const forward = (path: string) => {
    if (isMarkdownPath(path)) onChange();
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
 * Dot-paths *inside the vault* are always ignored — that is what stops the
 * server's own writes under `.neuro-vault/corpus/` from feeding this watcher
 * back into itself. The rule is judged relative to the vault root, so a
 * vault living under an unrelated dot-directory is not itself blinded.
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
      try {
        onQuiet();
      } catch (err) {
        // A watcher must never fail the server — a throwing onQuiet would
        // otherwise become an uncaught exception inside a Node timer.
        const reason = err instanceof Error ? err.message : String(err);
        warn(`[semantic] vault watcher onQuiet handler threw for "${vaultName}": ${reason}`);
      }
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
