#!/usr/bin/env bash
# bun run release [patch|minor|major] [--dry-run]: cut a release LOCALLY.
#
# Branch-detected: the same command cuts a PROD or a STAGING build depending on
# which branch you are on:
#   - on the repo default branch (`main`) → a PROD build: `npm version <kind>`
#     (patch|minor|major) → `git push --follow-tags`. CI publishes the clean
#     `vX.Y.Z` tag to the `latest` dist-tag.
#   - on the long-lived `staging` branch → a STAGING build: version =
#     `<bumped-base>-staging.<UTC timestamp>`. The bump commit + tag stay on the
#     `staging` branch (keeps prerelease history off main). CI routes the
#     `-staging.` suffix to the `staging` dist-tag.
#   - on any other branch → abort (real run errors; --dry-run warns then stops).
#
# This script only bumps + tags + pushes; it NEVER publishes to npm. CI publishes
# on the pushed `vX.Y.Z` (or `vX.Y.Z-staging.<stamp>`) tag, routing by the version
# suffix (see .github/workflows/release.yml). `npm version <...>` fires the
# `version` lifecycle hook (see package.json), which bumps package.json,
# regenerates+stages src/shared/version.ts, commits, and creates the annotated
# tag. We just push it (tags included).
#
# A `--dry-run` flag (allowed anywhere in the args) runs the same guard checks but
# DOWNGRADES violations to warnings, then PRINTS the mutating commands instead of
# running them and exits 0, mutating nothing (no bump, commit, tag, or push).
#
# Resolves the checkout root from the script's own location, so it works from any
# subdirectory of the checkout (scripts/ -> repo root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: bun run release [patch|minor|major] [--dry-run]" >&2
  echo "  bump kind defaults to 'patch'; --dry-run prints what it would do" >&2
  echo "  run on 'main' for a prod build, on 'staging' for a staging build" >&2
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
  guard "working tree is not clean; commit or stash changes before releasing"
fi

# --- determine MODE from the current branch -----------------------------------
# Default branch = the branch origin/HEAD points at; fall back to 'main' when the
# origin/HEAD ref is absent (e.g. a fresh clone that never ran `remote set-head`).
# The trailing `|| true` is required: when origin/HEAD is missing, git exits
# nonzero and `set -o pipefail` propagates that, which under `set -e` would abort
# the whole script (a plain assignment is NOT exempt from `set -e`), defeating
# the `:-main` fallback below. `|| true` keeps the pipeline non-fatal.
DEFAULT_BRANCH="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-main}"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ]; then
  MODE="prod"
elif [ "$CURRENT_BRANCH" = "staging" ]; then
  MODE="staging"
else
  MODE="unknown"
fi

# --- guard 2: branch must be main (prod) or staging ---------------------------
# On any other branch a real run aborts; a --dry-run warns then stops without
# mutating anything (it has no version to compute), matching the clean-tree guard.
if [ "$MODE" = "unknown" ]; then
  guard "release only from main or staging (on branch '$CURRENT_BRANCH')"
  echo "# release: dry-run, would abort (not on main or staging); nothing mutated"
  exit 0
fi

echo "# release: mode=$MODE branch=$CURRENT_BRANCH (default=$DEFAULT_BRANCH)"

# --- guard 3: gates green, abort on first failure, in this order --------------
# Run for both prod and staging modes (and in dry-run too) to surface a broken
# build before any mutation.
echo "# release: running gates (bun test, typecheck, build)"
bun test
bun run typecheck
bun run build

# --- staging path: version = <bumped-base>-staging.<UTC timestamp> ------------
if [ "$MODE" = "staging" ]; then
  STAMP="$(date -u +%Y%m%d%H%M%S)"
  VERSION="$(bun scripts/staging-version.ts "$KIND" "$STAMP")"
  if [ -z "$VERSION" ]; then
    echo "error: failed to compute staging version (empty output)" >&2
    exit 1
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "# release: dry-run (staging), would cut $VERSION; nothing mutated:"
    echo "    npm version $VERSION"
    echo "    git push --follow-tags"
    exit 0
  fi

  echo "# release: bumping to staging version $VERSION; npm version fires the version hook"
  npm version "$VERSION"
  NEW_TAG="v$VERSION"

  echo "# release: pushing commit + tag to origin (staging branch)"
  git push --follow-tags

  echo "# release: released $VERSION (tag $NEW_TAG); CI routes the -staging. suffix to the staging dist-tag"
  exit 0
fi

# --- prod path (default branch): identical to the original prod flow ----------
# --- dry run: print the two mutating commands and stop (mutate nothing) --------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "# release: dry-run, would run the following (nothing mutated):"
  echo "    npm version $KIND"
  echo "    git push --follow-tags"
  exit 0
fi

# --- real run: bump+tag (via the version hook), then push tags ----------------
echo "# release: bumping version ($KIND); npm version fires the version hook"
npm version "$KIND"
NEW_VERSION="$(node -pe 'require("./package.json").version')"
NEW_TAG="v$NEW_VERSION"

echo "# release: pushing commit + tag to origin"
git push --follow-tags

echo "# release: released $NEW_VERSION (tag $NEW_TAG); CI publishes on the pushed tag"
