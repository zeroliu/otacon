import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dogfoodSkillMd } from "../src/cli/install/assets.js";
import { writeDogfoodAsset } from "./gen-skill-asset.js";

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
