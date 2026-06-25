#!/usr/bin/env bun
/**
 * Materializes `skillMd()` into `dist/skills/otacon/SKILL.md` at build time, so the
 * installed product wrapper can SYMLINK to a real file shipped inside the npm
 * package. A symlink target must be a stable on-disk path; `skillMd()` is a function,
 * not a file, so the build emits its output here once and `files: ["dist"]` ships it.
 * A binary upgrade then refreshes every symlinked wrapper for free. Same generated-file
 * pattern as `scripts/gen-version.ts` and the dogfood `.claude/skills/otacon-dev/SKILL.md`.
 *
 * Run with: `bun run scripts/gen-skill-asset.ts` (or `bun run gen:skill`); the build
 * chain runs it after `tsc` (so `dist/` exists) and before the `chmod`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { skillMd } from "../src/cli/install/assets.js";

// Resolve the shipped asset path relative to this script (scripts/ -> repo root),
// independent of the cwd the generator is invoked from.
export function skillAssetTarget(): string {
  return fileURLToPath(new URL("../dist/skills/otacon/SKILL.md", import.meta.url));
}

/**
 * Write `skillMd()` to `target` (default the shipped path), creating parent dirs.
 * The `target` seam lets `wrapper.test.ts` write to a temp dir without touching dist.
 */
export function writeSkillAsset(target = skillAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, skillMd());
  return target;
}

if (import.meta.main) {
  const target = writeSkillAsset();
  console.log(`Wrote ${target}`);
}
