#!/bin/sh
# Runs `npm ci` when a git operation changed package-lock.json, so node_modules never
# drifts from the lockfile. A stale install makes type-aware lint report errors that
# CI, which always installs fresh, never sees. Wired up in lefthook.yml.
#
# Usage:
#   sync-deps.sh checkout <old-head> <new-head> <branch-flag>   (post-checkout)
#   sync-deps.sh merge                                          (post-merge)
#   sync-deps.sh rewrite <amend|rebase>                         (post-rewrite)
set -eu

in_rebase() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] ||
    [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

lockfile_changed() {
  # An all-zero old head means a fresh checkout (`git worktree add`): nothing installed yet.
  case $1 in *[!0]*) ;; *) return 0 ;; esac
  ! git diff --quiet "$1" "$2" -- package-lock.json
}

case $1 in
  checkout)
    # File checkouts (flag 0) leave HEAD alone; a rebase's checkouts are handled by
    # post-rewrite once it finishes.
    [ "$4" = 1 ] || exit 0
    in_rebase && exit 0
    lockfile_changed "$2" "$3" || exit 0
    ;;
  merge)
    lockfile_changed ORIG_HEAD HEAD || exit 0
    ;;
  rewrite)
    [ "$2" = rebase ] || exit 0
    lockfile_changed ORIG_HEAD HEAD || exit 0
    ;;
  *)
    echo "sync-deps: unknown mode '$1'" >&2
    exit 2
    ;;
esac

echo "sync-deps: package-lock.json changed, running npm ci"
npm ci
