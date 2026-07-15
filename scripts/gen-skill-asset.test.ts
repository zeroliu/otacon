import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dogfoodReviewSkillMd, dogfoodSkillMd, reviewSkillMd } from "../src/cli/install/assets.js";
import {
  writeDogfoodAsset,
  writeDogfoodReviewAsset,
  writeReviewSkillAsset,
} from "./gen-skill-asset.js";

// Drift guard: the committed dogfood wrapper must byte-equal dogfoodSkillMd().
// writeDogfoodAsset() is the exact write `gen:skill` runs for the committed file, so
// exercising it against a temp target proves the generator emits current protocol text.
test("writeDogfoodAsset writes a byte-equal copy of dogfoodSkillMd()", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-skill-asset-test-"));
  const target = join(dir, "SKILL.md");
  try {
    const written = writeDogfoodAsset(target);
    expect(written).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(dogfoodSkillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review packaged and dogfood assets equal their generators", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-review-skill-asset-test-"));
  const packaged = join(dir, "packaged", "SKILL.md");
  const dogfood = join(dir, "dogfood", "SKILL.md");
  try {
    expect(writeReviewSkillAsset(packaged)).toBe(packaged);
    expect(writeDogfoodReviewAsset(dogfood)).toBe(dogfood);
    expect(readFileSync(packaged, "utf8")).toBe(reviewSkillMd());
    expect(readFileSync(dogfood, "utf8")).toBe(dogfoodReviewSkillMd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
