#!/usr/bin/env bash
# bun run release [patch|minor|major] [--dry-run] — cut a release LOCALLY.
#
# This script only bumps + tags + pushes; it NEVER publishes to npm. CI publishes
# on the pushed `vX.Y.Z` tag (Phase 3). The flow on a real run is:
#   preflight guards → npm version <kind> → git push --follow-tags
# `npm version <kind>` fires the `version` lifecycle hook (see package.json),
# which bumps package.json, regenerates+stages src/shared/version.ts, commits,
# and creates the annotated tag. We just push it (tags included).
#
# A `--dry-run` flag (allowed anywhere in the args) runs the same guard checks but
# DOWNGRADES violations to warnings, then PRINTS the two mutating commands instead
# of running them and exits 0 — mutating nothing (no bump, commit, tag, or push).
#
# Resolves the checkout root from the script's own location, so it works from any
# subdirectory of the checkout (scripts/ -> repo root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: bun run release [patch|minor|major] [--dry-run]" >&2
  echo "  bump kind defaults to 'patch'; --dry-run prints what it would do" >&2
}

# --- parse args: one optional bump kind + an optional --dry-run (any order) ----
KIND=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    patch|minor|major)
      if [ -n "$KIND" ]; then
        echo "error: bump kind given more than once ('$KIND' then '$arg')" >&2
        usage
        exit 2
      fi
      KIND="$arg"
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      usage
      exit 2
      ;;
  esac
done
KIND="${KIND:-patch}" # default bump kind

# In a real run guard violations are fatal; in a dry run they become warnings.
# guard <message>: abort (real) or warn (dry-run) without mutating anything.
guard() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "warning (dry-run): $1" >&2
  else
    echo "error: $1" >&2
    exit 1
  fi
}

echo "# release: kind=$KIND dry-run=$DRY_RUN  ($ROOT)"

# --- guard 1: working tree must be clean (no staged/unstaged/untracked) --------
# Checked first so a real run aborts BEFORE any bump when the tree is dirty.
if [ -n "$(git status --porcelain)" ]; then
  guard "working tree is not clean — commit or stash changes before releasing"
fi

# --- guard 2: must be on the repo's default branch ----------------------------
# Default branch = the branch origin/HEAD points at; fall back to 'main' when the
# origin/HEAD ref is absent (e.g. a fresh clone that never ran `remote set-head`).
# The trailing `|| true` is required: when origin/HEAD is missing, git exits
# nonzero and `set -o pipefail` propagates that, which under `set -e` would abort
# the whole script (a plain assignment is NOT exempt from `set -e`) — defeating
# the `:-main` fallback below. `|| true` keeps the pipeline non-fatal.
DEFAULT_BRANCH="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "$DEFAULT_BRANCH" ]; then
  guard "on branch '$CURRENT_BRANCH', expected default branch '$DEFAULT_BRANCH'"
fi

# --- guard 3: gates green — abort on first failure, in this order --------------
# Kept identical in both modes (run them either way) to keep the script simple
# and to surface a broken build in dry-run too.
echo "# release: running gates (bun test, typecheck, build)"
bun test
bun run typecheck
bun run build

# --- dry run: print the two mutating commands and stop (mutate nothing) --------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "# release: dry-run — would run the following (nothing mutated):"
  echo "    npm version $KIND"
  echo "    git push --follow-tags"
  exit 0
fi

# --- real run: bump+tag (via the version hook), then push tags ----------------
echo "# release: bumping version ($KIND) — npm version fires the version hook"
npm version "$KIND"
NEW_VERSION="$(node -pe 'require("./package.json").version')"
NEW_TAG="v$NEW_VERSION"

echo "# release: pushing commit + tag to origin"
git push --follow-tags

echo "# release: released $NEW_VERSION (tag $NEW_TAG) — CI publishes on the pushed tag"
