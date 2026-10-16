import path from 'node:path';

import chokidar from 'chokidar';

import type { VaultScope } from '../obsidian/vault-scope.js';

/** The two scope questions the watcher asks — pruning a directory, filtering a note. */
export type WatcherScope = Pick<VaultScope, 'isExcluded' | 'isSubtreeExcluded'>;

/** A running watcher. `close()` is idempotent-safe and always awaited on shutdown. */
export interface WatcherHandle {
  close(): Promise<void>;
}

/** Builds the underlying watch. Production default: chokidar; tests inject a fake. */
export interface WatcherFactory {
  (opts: {
    vaultRoot: string;
    scope: WatcherScope;
    onChange: () => void;
    onError: (err: unknown) => void;
  }): WatcherHandle;
}

export interface VaultWatcherDeps {
  vaultRoot: string;
  vaultName: string;
  /** What the vault discovers — the one definition of scope, shared with the readers. */
  scope: WatcherScope;
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
 * `p` relative to the vault root with `/` separators — the form the scope
 * judges. A Windows root (one containing a backslash) is resolved with `path.win32`
 * so the result is the same whichever platform runs this.
 *
 * Judging the vault-relative path, not the absolute one chokidar hands over,
 * is what lets a vault live under a dot-directory (e.g. `~/.sync/vault`): a
 * dot segment *above* the root never reaches the scope.
 */
export function vaultRelative(vaultRoot: string, p: string): string {
  const rel = vaultRoot.includes('\\')
    ? path.win32.relative(vaultRoot, p)
    : path.relative(vaultRoot, p);
  return rel.replaceAll('\\', '/');
}

/**
 * Whether chokidar should skip `p` (and, for a directory, everything below it).
 * True only when the scope proves the whole subtree excluded — a dot segment, or
 * a `<prefix>/**` pattern. `Archive/*` excludes `Archive`'s children but not
 * `Archive/2024/note.md`, so it must not prune: chokidar 4 drops a whole
 * subtree once `ignored` is true for its directory. The vault root is never
 * pruned (its relative path is empty). chokidar also asks about files, which is
 * still sound: anything inside a provably excluded subtree is excluded.
 */
export function isPrunedDir(scope: WatcherScope, vaultRoot: string, p: string): boolean {
  return scope.isSubtreeExcluded(vaultRelative(vaultRoot, p));
}

/**
 * `ignored` never filters by extension or by a per-file rule, so this is what
 * keeps non-`.md` churn and notes the scope excludes (`Archive/*`, `*.canvas.md`
 * and the like) out of `onChange`. It also covers the server's own writes under
 * `.neuro-vault/corpus/`: the dot rule excludes them (design D6).
 */
export function isWatchedNote(scope: WatcherScope, vaultRoot: string, p: string): boolean {
  return p.endsWith('.md') && !scope.isExcluded(vaultRelative(vaultRoot, p));
}

function defaultCreateWatcher({
  vaultRoot,
  scope,
  onChange,
  onError,
}: {
  vaultRoot: string;
  scope: WatcherScope;
  onChange: () => void;
  onError: (err: unknown) => void;
}): WatcherHandle {
  const watcher = chokidar.watch(vaultRoot, {
    // chokidar's `stats` argument is unreliable in v4, so only the path is used.
    ignored: (p: string) => isPrunedDir(scope, vaultRoot, p),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2_000, pollInterval: 200 },
  });

  const forward = (p: string) => {
    if (isWatchedNote(scope, vaultRoot, p)) onChange();
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
 * The vault scope decides what counts: only an add/change/unlink of a `.md`
 * path the scope does not exclude arms the timer, and chokidar prunes only the
 * subtrees the scope proves excluded. Dot-paths inside the vault are always
 * excluded — that is what stops the server's own writes under
 * `.neuro-vault/corpus/` from feeding this watcher back into itself. Paths are
 * judged relative to the vault root, so a vault living under an unrelated
 * dot-directory is not itself blinded.
 *
 * A watcher that fails to start, or errors later, degrades: it warns to
 * stderr and never throws. The vault then reconciles only when a pass is asked
 * for some other way — on every attach — and the server keeps serving either way.
 */
export function startVaultWatcher(deps: VaultWatcherDeps): WatcherHandle {
  const {
    vaultRoot,
    vaultName,
    scope,
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
        warn(`neuro-vault watcher: vault "${vaultName}": onQuiet threw: ${reason}`);
      }
    }, debounceMs);
  };

  const onError = (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`neuro-vault watcher: vault "${vaultName}": ${reason}`);
  };

  let handle: WatcherHandle;
  try {
    handle = createWatcher({ vaultRoot, scope, onChange: scheduleQuiet, onError });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warn(`neuro-vault watcher: vault "${vaultName}": failed to start: ${reason}`);
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
