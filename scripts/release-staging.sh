#!/usr/bin/env bash
# bun run release:staging [minor|major] [--dry-run]: cut a STAGING prerelease LOCALLY.
#
# Mirrors scripts/release.sh, but cuts a `vX.Y.Z-staging.N` prerelease from the
# `staging` branch (NOT main). Like release.sh it only bumps + tags + pushes; it
# NEVER publishes to npm. CI publishes on the pushed tag and routes by version
# suffix: a `-staging.` version goes to the npm `staging` dist-tag (see
# .github/workflows/release.yml). The flow on a real run is:
#   preflight guards → npm version <mode> --preid staging → git push --follow-tags
# `npm version` fires the `version` lifecycle hook (see package.json), which bumps
# package.json, regenerates+stages src/shared/version.ts, commits, and creates the
# annotated `vX.Y.Z-staging.N` tag. We just push it (tags included).
#
# Bump kind arg (optional): `minor` or `major`. Default = none. They map to:
#   none  → npm version prerelease  --preid staging
#   minor → npm version preminor    --preid staging
#   major → npm version premajor    --preid staging
# Note: `patch` is NOT a distinct mode here. The default `prerelease` already
# advances to the next patch line from a clean version (0.1.3 → 0.1.4-staging.0)
# and increments the `-staging.N` build counter when already on a staging
# prerelease (0.1.4-staging.0 → 0.1.4-staging.1). So `patch` is aliased to the
# default (no bump kind) rather than rejected, since it reads as "the next patch
# staging build", exactly what the default does.
#
# A `--dry-run` flag (allowed anywhere in the args) runs the same guard checks but
# DOWNGRADES violations to warnings, then PRINTS the two mutating commands instead
# of running them and exits 0, mutating nothing (no bump, commit, tag, or push).
#
# Resolves the checkout root from the script's own location, so it works from any
# subdirectory of the checkout (scripts/ -> repo root).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  echo "usage: bun run release:staging [minor|major] [--dry-run]" >&2
  echo "  no bump kind = next prerelease build; --dry-run prints what it would do" >&2
}

# --- parse args: one optional bump kind + an optional --dry-run (any order) ----
# KIND is the npm version mode (prerelease | preminor | premajor); empty means the
# default prerelease, which the arg loop maps below.
KIND=""
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    minor|major|patch)
      if [ -n "$KIND" ]; then
        echo "error: bump kind given more than once" >&2
        usage
        exit 2
      fi
      # patch is aliased to the default prerelease (see header), not a distinct mode.
      case "$arg" in
        minor) KIND="preminor" ;;
        major) KIND="premajor" ;;
        patch) KIND="prerelease" ;;
      esac
      ;;
    *)
      echo "error: unknown argument '$arg'" >&2
      usage
      exit 2
      ;;
  esac
done
KIND="${KIND:-prerelease}" # default: next prerelease build

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

echo "# release:staging: mode=$KIND dry-run=$DRY_RUN  ($ROOT)"

# --- guard 1: working tree must be clean (no staged/unstaged/untracked) --------
# Checked first so a real run aborts BEFORE any bump when the tree is dirty.
if [ -n "$(git status --porcelain)" ]; then
  guard "working tree is not clean; commit or stash changes before releasing"
fi

# --- guard 2: must be on the 'staging' branch (NOT main) -----------------------
# Staging builds are cut from the dedicated staging branch so a prerelease never
# rides on the default branch's history.
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "staging" ]; then
  guard "on branch '$CURRENT_BRANCH', expected 'staging'"
fi

# --- guard 3: gates green, abort on first failure, in this order --------------
# Kept identical in both modes (run them either way) to keep the script simple
# and to surface a broken build in dry-run too.
echo "# release:staging: running gates (bun test, typecheck, build)"
bun test
bun run typecheck
bun run build

# --- dry run: print the two mutating commands and stop (mutate nothing) --------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "# release:staging: dry-run, would run the following (nothing mutated):"
  echo "    npm version $KIND --preid staging"
  echo "    git push --follow-tags"
  exit 0
fi

# --- real run: bump+tag (via the version hook), then push tags ----------------
echo "# release:staging: bumping version ($KIND --preid staging); npm version fires the version hook"
npm version "$KIND" --preid staging
NEW_VERSION="$(node -pe 'require("./package.json").version')"
NEW_TAG="v$NEW_VERSION"

echo "# release:staging: pushing commit + tag to origin"
git push --follow-tags

echo "# release:staging: released $NEW_VERSION (tag $NEW_TAG); CI publishes to the staging dist-tag on the pushed tag"
