#!/usr/bin/env bun
/**
 * Assembles the prerelease version string for a `staging` channel cut:
 * `<bumped-core>-staging.<stamp>`. This is the single source of truth for the
 * shape staging builds take; the branch-detected scripts/release.sh calls the
 * direct-run CLI below on the `staging` branch instead of stringing the version
 * together in shell.
 *
 * The output is consumed by the channel-aware auto-updater in src/cli/update.ts:
 * `channelOf` only treats a build as `staging` when it matches `/-staging\./`
 * (literal dot), and `isNewer` orders staging builds by the digits in
 * `/-staging\.(\d+)/`. So the output MUST contain `-staging.` and `stamp` MUST be
 * all decimal digits, or staging installs silently break — hence the throws here.
 *
 * Run directly: `bun scripts/staging-version.ts <kind> <stamp>` prints ONLY the
 * resulting version (kind defaults to "patch"; stamp is required). The current
 * version is read from the repo-root package.json, resolved relative to this
 * script (cwd-independent), exactly like scripts/gen-version.ts.
 */
import { readFileSync } from "node:fs";

type Kind = "patch" | "minor" | "major";

/**
 * Build a staging prerelease version: strip any prerelease off `current` to get
 * the clean `X.Y.Z` core (so repeated cuts never inflate the base), bump it by
 * `kind` (npm version semantics, parsed manually — the repo has no semver dep,
 * mirroring src/cli/update.ts's parseSemver), and append `-staging.<stamp>`.
 *
 * Throws on an unparseable `current` (not `X.Y.Z[-...]` with numeric parts) or a
 * `stamp` that is empty or not all decimal digits — never emits a malformed
 * version the auto-updater would reject.
 */
export function stagingVersion(args: { current: string; kind: Kind; stamp: string }): string {
  const { current, kind, stamp } = args;

  if (!/^\d+$/.test(stamp)) {
    throw new Error(`staging build stamp must be all decimal digits, got: ${JSON.stringify(stamp)}`);
  }

  const core = parseCore(current);
  if (core === undefined) {
    throw new Error(`cannot parse a clean X.Y.Z core from current version: ${JSON.stringify(current)}`);
  }

  const [x, y, z] = core;
  let base: string;
  switch (kind) {
    case "major":
      base = `${x + 1}.0.0`;
      break;
    case "minor":
      base = `${x}.${y + 1}.0`;
      break;
    case "patch":
      base = `${x}.${y}.${z + 1}`;
      break;
  }

  return `${base}-staging.${stamp}`;
}

/**
 * Parse the clean `X.Y.Z` core out of a version string, ignoring a leading `v`
 * and any `-prerelease` / `+build` suffix. Returns undefined when it is not three
 * numeric dot-separated parts. Matches the manual-parse style in src/cli/update.ts.
 */
function parseCore(version: string): [number, number, number] | undefined {
  if (typeof version !== "string") return undefined;
  const trimmed = version.trim().replace(/^v/, "");
  const core = trimmed.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

/** Narrow a raw CLI arg to a Kind, defaulting to "patch"; throws on anything else. */
function parseKind(raw: string | undefined): Kind {
  if (raw === undefined) return "patch";
  if (raw === "patch" || raw === "minor" || raw === "major") return raw;
  throw new Error(`unknown kind ${JSON.stringify(raw)} — expected patch | minor | major`);
}

// Direct-run CLI: `bun scripts/staging-version.ts <kind> <stamp>`. Run only when
// this file is executed directly (not when imported by the test), the bun/ESM
// idiom of comparing import.meta.main.
if (import.meta.main) {
  const kind = parseKind(process.argv[2]);
  const stamp = process.argv[3];
  if (stamp === undefined) {
    throw new Error("usage: bun scripts/staging-version.ts <kind> <stamp> — stamp is required");
  }
  // Resolve repo-root package.json relative to this script (scripts/ -> repo root),
  // independent of the cwd, exactly like scripts/gen-version.ts.
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing a non-empty `version` field");
  }
  process.stdout.write(`${stagingVersion({ current: pkg.version, kind, stamp })}\n`);
}
