#!/usr/bin/env bash
# verify-worktree.sh — one command to manually e2e a worktree's changes.
# Run from the MAIN checkout:  bun run verify:wt <worktree-name> [flavor]
#
# Builds the worktree, restarts its daemon from current source, then populates a
# realistic review session and opens it in the browser. The worktree's own
# bin/otacon is the daemon guarantee — every call runs ensureDaemon (spawn +
# wait-for-health) — and a source daemon serves the built UI, so the worktree
# must be current with main (branched from it, or rebased onto it once). New
# worktrees cut from main already are.
#
#   bun run verify:wt expressive-plan-visuals visuals
#   bun run verify:wt attention-notifications notify
#   bun run verify:wt live-agent-activity activity
#
# Location-independent: finds the worktree by name via `git worktree list`,
# wherever it lives (convention: ~/worktrees/otacon/<name>).
set -euo pipefail

WT="${1:?usage: bun run verify:wt <worktree-name> [flavor: full|visuals|notify|activity]}"
FLAVOR="${2:-full}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WTDIR="$(git -C "$ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | grep -E "/$WT/?$" | head -1)"
[ -n "$WTDIR" ] && [ -d "$WTDIR" ] || { echo "error: no worktree named '$WT' — see: git worktree list" >&2; exit 1; }

echo "# [$WT] installing deps + building   ($WTDIR)"
# Worktrees don't share the main checkout's node_modules — a fresh (or freshly
# moved) one has none, so install before build or `tsc` won't be found.
LOG="$(mktemp)"
if ! ( cd "$WTDIR" && bun install && bun run build ) >"$LOG" 2>&1; then
  echo "# [$WT] install/build FAILED:" >&2; tail -25 "$LOG" >&2; rm -f "$LOG"; exit 1
fi
rm -f "$LOG"

echo "# [$WT] restarting daemon from current source"
( cd "$WTDIR" && ./bin/otacon restart >/dev/null 2>&1 || true )

echo "# [$WT] populating '$FLAVOR' session"
# Populate logic lives on MAIN (always present) but runs in the worktree, so its
# bin/otacon hits this worktree's isolated daemon and serves the built UI.
( cd "$WTDIR" && bash "$ROOT/test/populate-session.sh" "$FLAVOR" )
