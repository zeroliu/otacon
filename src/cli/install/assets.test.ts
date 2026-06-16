import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { dogfoodSkillMd, skillMd } from "./assets.js";

// The committed dogfood wrapper, regenerated from dogfoodSkillMd() (D7).
const DOGFOOD_SKILL_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".claude",
  "skills",
  "otacon",
  "SKILL.md",
);

describe("single-source wrappers (D7)", () => {
  test("the committed dogfood SKILL.md is exactly dogfoodSkillMd()", () => {
    // This is the drift guard: a protocol change that edits assets.ts but
    // forgets to regenerate .claude/skills/otacon/SKILL.md fails right here.
    const committed = readFileSync(DOGFOOD_SKILL_PATH, "utf8");
    expect(committed).toBe(dogfoodSkillMd());
  });

  test("the dogfood wrapper runs from source (./bin/otacon); the global wrappers don't", () => {
    const dogfood = dogfoodSkillMd();
    expect(dogfood).toContain("./bin/otacon start --title");
    expect(dogfood).toContain("./bin/otacon progress");
    expect(dogfood).toContain("./bin/otacon restart"); // the repo preamble
    // The installed wrapper (Claude/Codex/OpenCode share it) carries no
    // source-mode command prefix.
    expect(skillMd()).not.toContain("./bin/otacon");
  });

  test("every wrapper teaches the start-first loop and the progress verb", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // start-first (D6): the start step leads, before research.
      expect(text).toContain("first, before you research");
      expect(text).toMatch(/2\. \*\*Research the codebase\*\*/);
      // the new narration verb (D1) appears in the loop and the rules.
      expect(text).toContain('progress "<what you\'re doing>"');
    }
  });

  test("every wrapper teaches the terminal `deleted` event (delete-pending-session)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // The review loop must stop, not re-park or error, when the user deletes
      // a pending session in the UI (DESIGN.md §6).
      expect(text).toContain("`deleted`");
      expect(text).toContain("deleted this session in the review UI");
    }
  });
});
