#!/usr/bin/env bash
# verify-branch.sh — one command to manually e2e the CURRENT branch's changes.
# Run from any checkout (the main repo OR a worktree):  bun run verify:branch [flavor]
#
# Builds this checkout, restarts its daemon from current source, then populates a
# realistic review session and opens it. bin/otacon derives an isolated daemon
# port + home from the checkout's own path, so the main repo and every worktree
# get their own daemon and never collide — run it wherever the branch you want to
# test is checked out. A source daemon serves the built UI, so keep the branch
# current with main (worktrees: cut from main, or rebase once).
#
#   bun run verify:branch            # full session
#   bun run verify:branch visuals
#   bun run verify:branch notify
#   bun run verify:branch activity
#
# Resolves the checkout root from the script's own location, so it works from any
# subdirectory of the checkout.
set -euo pipefail

FLAVOR="${1:-full}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || basename "$ROOT")"

case "$FLAVOR" in
  full|visuals|notify|activity) ;;
  *) echo "error: unknown flavor '$FLAVOR' (expected: full|visuals|notify|activity)" >&2; exit 1 ;;
esac

echo "# [$BRANCH] installing deps + building   ($ROOT)"
# A fresh (or freshly moved) worktree has no node_modules of its own, so install
# before build or `tsc` won't be found. The main checkout already has them.
LOG="$(mktemp)"
if ! ( cd "$ROOT" && bun install && bun run build ) >"$LOG" 2>&1; then
  echo "# [$BRANCH] install/build FAILED:" >&2; tail -25 "$LOG" >&2; rm -f "$LOG"; exit 1
fi
rm -f "$LOG"

echo "# [$BRANCH] restarting daemon from current source"
( cd "$ROOT" && ./bin/otacon restart >/dev/null 2>&1 || true )

echo "# [$BRANCH] populating '$FLAVOR' session"
# populate-session.sh runs against this checkout's own ./bin/otacon, so it hits
# this checkout's isolated daemon and serves the built UI.
( cd "$ROOT" && bash "$ROOT/test/populate-session.sh" "$FLAVOR" )
