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
# Rendered-output check (the browse/gstack manual recipe — Phase 4 of
# verify-before-merge). The gated assertion lives in test/ui/question-linebreaks.e2e.ts,
# but to eyeball the rendered-output class (line breaks, wrapping, callouts) on
# this checkout's live session, drive the browse/gstack headless browser:
#   1. bun run verify:branch visuals      # populate + open; copy the REVIEW url it prints
#   2. /browse  (or the `browse` skill): navigate <REVIEW-url>
#   3. screenshot .grill-question (or a callout/matrix); confirm paragraphs stay
#      separated and nothing collapses to one run-on line
#   4. before/after a change: browse's diff catches a rendering regression visually,
#      the way the e2e catches it in CI. Playwright = gated assertion, browse = fast
#      manual aid (the q5 split).
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
