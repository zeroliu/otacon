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
  "otacon-dev",
  "SKILL.md",
);

describe("single-source wrappers (D7)", () => {
  test("the committed dogfood SKILL.md is exactly dogfoodSkillMd()", () => {
    // This is the drift guard: a protocol change that edits assets.ts but
    // forgets to regenerate .claude/skills/otacon-dev/SKILL.md fails right here.
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
      expect(text).toMatch(/2\. \*\*Research the codebase\.\*\*/);
      // the new narration verb (D1) appears in the loop and the rules.
      expect(text).toContain('progress "<what you\'re doing>"');
    }
  });

  test("the wrapper reframes progress as occasional highlights + the universal floor", () => {
    // Phase 4: auto-capture covers routine work on supported agents, so the
    // wrapper asks for OCCASIONAL highlights / chapter markers, not per-step
    // narration — while still naming `progress` as the activity floor on agents
    // with no auto-capture. The command itself must remain present (not removed).
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // It tells the agent to use progress sparingly, for highlights/markers.
      expect(text).toMatch(/OCCASIONAL highlights and chapter markers/);
      // It explains the auto-stream now covers routine activity.
      expect(text).toMatch(/auto-stream/);
      // It still keeps progress alive as the universal floor.
      expect(text).toContain("universal floor");
      // The command stays in the CLI quick reference.
      expect(text).toMatch(/progress "<note>"/);
    }
    // The plain `otacon progress` command is still present (not removed); the
    // dogfood variant carries its source-prefixed form.
    expect(skillMd()).toContain("otacon progress");
    expect(dogfoodSkillMd()).toContain("./bin/otacon progress");
  });

  test("every wrapper teaches the terminal `deleted` event (delete-pending-session)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // The review loop must stop, not re-park or error, when the user deletes
      // a pending session in the UI.
      expect(text).toContain("`deleted`");
      expect(text).toContain("deleted this session in the review UI");
    }
  });

  test("every wrapper makes implementation wait for explicit Implement approval", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      expect(text).toContain("## Hard implementation gate");
      expect(text).toContain("MUST NOT create, edit, delete, or format project");
      expect(text).toContain('{"event":"approved",...,"implement":true}');
      expect(text).toContain("Approval is not implied by the original request");
      expect(text).toContain("After a clean submit, stop all implementation work");
      expect(text).toContain("If you notice you edited project files before `approved implement:true`");
    }
  });

  test("every wrapper teaches the resume-from-worktree bootstrap and amend-in-place", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // The start bootstrap: a resumeCandidate from status means an amendment is
      // possible, so judge relatedness, confirm in the terminal, then resume.
      expect(text).toContain("resumeCandidate");
      expect(text).toContain("resume and amend");
      // Amend-in-place: build on the existing worktree/branch and push the same PR.
      expect(text).toContain("Amending");
      expect(text).toContain("updates the SAME PR");
    }
  });

  test("every wrapper teaches shape-matched lead visuals and demotes graph TD from the default", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // Tree/hierarchy-shaped content still goes to a mermaid diagram, not a
      // monospace outline.
      expect(text).toContain("a hierarchy or tree");
      expect(text).toContain("monospace nested outline");
      // graph TD is demoted from "the natural default" to one option among many.
      expect(text).not.toContain("is the natural default");
      expect(text).toContain("is one option, not the");
      // The shape->type rubric and the named anti-patterns ship in every wrapper.
      expect(text).toContain("Match the representation to the content's shape");
      expect(text).toContain("Diagram anti-patterns");
      expect(text).toContain("decision-matrix table");
    }
  });

  test("every wrapper teaches socratic mode (activation + free-text-only + decisions trace, no [assumed])", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // Activation is the agent's job: recognize the request and pass --socratic.
      expect(text).toContain("--socratic");
      expect(text).toContain("Socratic mode (opt-in)");
      // Free-text-only enforcement: ask refuses option/recommend chips.
      expect(text).toContain("E_SOCRATIC_FREE_TEXT_ONLY");
      expect(text).toContain("Free-text only");
      // Decisions must trace to the user's reasoning; [assumed] is banned.
      expect(text).toContain("E_ASSUMED_NOT_ALLOWED");
      expect(text).toContain("Decisions trace to their reasoning");
      // Posture inversion + no downgrade are taught.
      expect(text).toContain("not an answer vending");
      expect(text).toContain("No downgrade");
    }
    // Each wrapper names its own command in the socratic start line (D7).
    expect(skillMd()).toContain("otacon start --title <t> --socratic");
    expect(dogfoodSkillMd()).toContain("./bin/otacon start --title <t> --socratic");
  });

  test("every wrapper teaches the comment & approve fold-in batch (final:true)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // A `final:true` comments batch ends the review: the next clean submit
      // finalizes (the agent gets `approved`, maybe implement:true), not another
      // review round.
      expect(text).toContain('`"final":true`');
      expect(text).toContain("next clean submit **finalizes**");
    }
  });
});
