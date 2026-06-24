import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSkillAsset } from "../../../scripts/gen-skill-asset.js";
import { skillMd } from "./assets.js";
import { packagedSkillPath } from "./wrapper.js";

// In the source/test context this module resolves to src/skills/otacon/SKILL.md,
// which never exists, so the packaged path is unreachable, deterministically
// undefined. That is the source-run behavior callers rely on to copy instead.
test("packagedSkillPath is undefined when run from source", () => {
  expect(packagedSkillPath()).toBeUndefined();
});

// Drift guard: the shipped asset must byte-equal skillMd(). writeSkillAsset() is the
// exact write the build runs, so exercising it against a temp target proves the
// generator emits current protocol text (no stale copy in the package).
test("writeSkillAsset writes a byte-equal copy of skillMd()", () => {
  const target = join(tmpdir(), `otacon-skill-asset-${process.pid}-${Date.now()}.md`);
  try {
    const written = writeSkillAsset(target);
    expect(written).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(skillMd());
  } finally {
    rmSync(target, { force: true });
  }
});
