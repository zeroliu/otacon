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

  test("every wrapper teaches the comment & approve fold-in batch (final:true)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // A `final:true` comments batch ends the review: the next clean submit
      // finalizes (the agent gets `approved`, maybe implement:true), not another
      // review round.
      expect(text).toContain('`"final":true`');
      expect(text).toContain("next clean submit **finalizes**");
    }
  });

  test("every wrapper teaches the verify-before-merge loop (non-goals, self-review, ledger, drift)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // Grill must pin observable behavior and record explicit non-goals as decisions.
      expect(text).toContain("OUT of scope");
      expect(text).toContain("record non-goals as");
      // A post-draft self-review pass before submit.
      expect(text).toContain("Self-review before you submit");
      // The implement loop assembles + passes the verification ledger; the gate refuses.
      expect(text).toContain("implement-done --ledger");
      expect(text).toContain("E_UNVERIFIED");
      // Per-phase scenario attestation feeds the ledger.
      expect(text).toContain("each Verification gwt scenario as");
      // The drift reconciliation is read at finish.
      expect(text).toContain("shippedBeyondPlan");
      // gwt scenarios are framed as the attested ledger, not just a human checklist.
      expect(text).toContain("ledger you must attest");
    }
  });

  test("the browse rendered-output recipe is dogfood-only (not in the shipped product wrapper)", () => {
    // browse/gstack is a dev-env tool, so the rendered-output recipe lives in the
    // dogfood preamble, never in the product wrapper users install.
    expect(dogfoodSkillMd()).toContain("browse/gstack headless browser");
    expect(skillMd()).not.toContain("browse/gstack");
  });
});
