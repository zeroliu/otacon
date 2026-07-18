#!/usr/bin/env bun
/**
 * Materializes `skillMd()` and `reviewSkillMd()` into their packaged skill
 * directories at build time, so installed product wrappers can SYMLINK to real
 * files shipped inside the npm package. A symlink target must be a stable on-disk
 * path; the generators are functions, not files, so the build emits their output
 * here once and `files: ["dist"]` ships it.
 * A binary upgrade then refreshes every symlinked wrapper for free. Same generated-file
 * pattern as `scripts/gen-version.ts` and the dogfood `.claude/skills/otacon-dev/SKILL.md`.
 *
 * It also materializes both dogfood generators into the committed wrappers under
 * `.claude/skills/`; assets.test.ts guards that both stay in sync.
 *
 * Run with: `bun run scripts/gen-skill-asset.ts` (or `bun run gen:skill`); the build
 * chain runs it after `tsc` (so `dist/` exists) and before the `chmod`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dogfoodReviewSkillMd,
  dogfoodSkillMd,
  reviewSkillMd,
  skillMd,
} from "../src/cli/install/assets.js";
import {
  implementV2SkillMd,
  planV2SkillMd,
  reviewV2SkillMd,
} from "../src/cli/install/assets-v2.js";

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

export function reviewSkillAssetTarget(): string {
  return fileURLToPath(new URL("../dist/skills/otacon-review/SKILL.md", import.meta.url));
}

export function writeReviewSkillAsset(target = reviewSkillAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, reviewSkillMd());
  return target;
}

// The Plan V2 prototype card ships packaged like the others so user installs
// can symlink to it. It has NO dogfood variant under `.claude/skills/` — the
// protocol never runs otacon commands, so there is nothing source-mode about it.
export function planV2SkillAssetTarget(): string {
  return fileURLToPath(new URL("../dist/skills/otacon-plan-v2/SKILL.md", import.meta.url));
}

export function writePlanV2SkillAsset(target = planV2SkillAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, planV2SkillMd());
  return target;
}

export function implementV2SkillAssetTarget(): string {
  return fileURLToPath(new URL("../dist/skills/otacon-implement-v2/SKILL.md", import.meta.url));
}

export function writeImplementV2SkillAsset(target = implementV2SkillAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, implementV2SkillMd());
  return target;
}

export function reviewV2SkillAssetTarget(): string {
  return fileURLToPath(new URL("../dist/skills/otacon-review-v2/SKILL.md", import.meta.url));
}

export function writeReviewV2SkillAsset(target = reviewV2SkillAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, reviewV2SkillMd());
  return target;
}

// Resolve the committed dogfood wrapper path relative to this script (scripts/ -> repo
// root), independent of the cwd the generator is invoked from. It's the committed
// dogfood wrapper, regenerated from `dogfoodSkillMd()` and guarded by assets.test.ts (D7).
export function dogfoodAssetTarget(): string {
  return fileURLToPath(new URL("../.claude/skills/otacon-dev/SKILL.md", import.meta.url));
}

/**
 * Write `dogfoodSkillMd()` to `target` (default the committed dogfood path), creating
 * parent dirs. The `target` seam lets tests write to a temp dir without touching the
 * committed file.
 */
export function writeDogfoodAsset(target = dogfoodAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, dogfoodSkillMd());
  return target;
}

export function dogfoodReviewAssetTarget(): string {
  return fileURLToPath(new URL("../.claude/skills/otacon-review-dev/SKILL.md", import.meta.url));
}

export function writeDogfoodReviewAsset(target = dogfoodReviewAssetTarget()): string {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, dogfoodReviewSkillMd());
  return target;
}

if (import.meta.main) {
  const published = writeSkillAsset();
  const publishedReview = writeReviewSkillAsset();
  const publishedPlanV2 = writePlanV2SkillAsset();
  const publishedImplementV2 = writeImplementV2SkillAsset();
  const publishedReviewV2 = writeReviewV2SkillAsset();
  const dogfood = writeDogfoodAsset();
  const dogfoodReview = writeDogfoodReviewAsset();
  console.log(`Wrote ${published}`);
  console.log(`Wrote ${publishedReview}`);
  console.log(`Wrote ${publishedPlanV2}`);
  console.log(`Wrote ${publishedImplementV2}`);
  console.log(`Wrote ${publishedReviewV2}`);
  console.log(`Wrote ${dogfood}`);
  console.log(`Wrote ${dogfoodReview}`);
}
