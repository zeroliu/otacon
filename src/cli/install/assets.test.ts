import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  dogfoodReviewSkillMd,
  dogfoodSkillMd,
  reviewSkillMd,
  skillMd,
} from "./assets.js";

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
const DOGFOOD_REVIEW_SKILL_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".claude",
  "skills",
  "otacon-review-dev",
  "SKILL.md",
);

describe("single-source wrappers (D7)", () => {
  test("the committed dogfood SKILL.md is exactly dogfoodSkillMd()", () => {
    // This is the drift guard: a protocol change that edits assets.ts but
    // forgets to regenerate .claude/skills/otacon-dev/SKILL.md fails right here.
    const committed = readFileSync(DOGFOOD_SKILL_PATH, "utf8");
    expect(committed).toBe(dogfoodSkillMd());
  });

  test("the committed review dogfood SKILL.md is exactly its generator", () => {
    expect(readFileSync(DOGFOOD_REVIEW_SKILL_PATH, "utf8")).toBe(dogfoodReviewSkillMd());
  });

  test("the review skills are concise and have only name + description frontmatter", () => {
    for (const text of [reviewSkillMd(), dogfoodReviewSkillMd()]) {
      expect(text.split("\n").length).toBeLessThan(500);
      const close = text.indexOf("\n---\n", 4);
      const keys = text.slice(4, close).split("\n").map((line) => line.split(":", 1)[0]);
      expect(keys).toEqual(["name", "description"]);
    }
  });

  test("review protocol owns PR review without leaking the plan protocol", () => {
    for (const text of [reviewSkillMd(), dogfoodReviewSkillMd()]) {
      expect(text).toContain("review start --pr <URL-or-number>");
      expect(text).toContain("Background");
      expect(text).toContain("Intuition");
      expect(text).toContain("interface changes, integration path, then");
      expect(text).toContain('`quiz-answer`');
      expect(text).toContain('`work:\"question\"`');
      expect(text).toContain('`work:\"report-feedback\"`');
      expect(text).toContain('`work:\"code-change\"`');
      expect(text).toContain("review revise --session");
      expect(text).toContain("Spawn one native");
      expect(text).toContain("main agent reviews its diff");
      expect(text).toContain("frontmatter is\nexactly these scalar keys in order");
      expect(text).toContain("### Interface changes —");
      expect(text).toContain("knowledge CAS first");
      expect(text.indexOf("knowledge CAS first")).toBeLessThan(
        text.indexOf("review revise --session <id>"),
      );
      expect(text).toContain("local clone\nroot as `--repo <root>`");
      expect(text).toContain("what the reviewer got right");
      expect(text).toContain("until `review-done` or");
      expect(text).not.toContain("start --title <kebab-title>");
      expect(text).not.toContain('{"event":"approved"');
      expect(text).not.toContain("plan.md");
    }
    expect(skillMd()).not.toContain("review start --pr");
    expect(skillMd()).not.toContain("quiz-answer");
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
      // Deprecated guidance must not slip back into either wrapper: the old
      // "lead with a diagram" mandate, or the stale fence rule that capped
      // mermaid at one per read-path section (mermaid is exempt from the cap).
      expect(text.toLowerCase()).not.toContain("lead with a diagram");
      expect(text).not.toContain("max one per read-path section");
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

  test("every wrapper tells the agent to pass the user's verbatim request via --prompt", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // Step 1 instructs the agent to capture the original ask verbatim, stripping
      // only the /otacon slash-command boilerplate, so the reviewer's Prompt card
      // is populated at session start.
      expect(text).toContain('Pass the user\'s ORIGINAL request verbatim as `--prompt "<their words>"`');
      expect(text).toContain("strip ONLY");
      expect(text).toContain("skill-invocation boilerplate");
      expect(text).toContain('populates a "Prompt" card');
      // The quick reference advertises the optional flag.
      expect(text).toContain('start --title <t> [--prompt "<request>"] [--quick]');
    }
  });

  test("every wrapper teaches focused, formatted questions (no walls)", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // Ask one decision per card, short by default.
      expect(text).toContain("One question, well-shaped.");
      // Long questions go through a temp file passed via --question "$(cat ...)".
      expect(text).toContain('ask --question "$(cat');
      // The wall-versus-formatted anti-example is present.
      expect(text).toContain("Wall (avoid):");
      // Socratic context-feeding points back at the question-shape rule.
      expect(text).toContain("never one wall");
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

  test("every wrapper teaches the reviewer-first PR body ported from the plan", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // The Finish step now authors a reviewer-first PR body by porting the plan,
      // not a free-form implementation log.
      expect(text).toContain("reviewer-first PR body");
      // The template's per-commit Changes section.
      expect(text).toContain("## Changes");
      // Decisions are ported with the local grill-question cites stripped.
      expect(text).toContain("drop the");
      expect(text).toContain("← q<n>");
      // On an amendment the whole body is refreshed, not appended as stubs.
      expect(text).toContain("refresh the whole body");
      // The old implementation-log phrasing is gone.
      expect(text).not.toContain("the plan summary + the per-phase log");
    }
  });

  test("every wrapper teaches draft-by-default PR creation via pr.draft / --draft", () => {
    for (const text of [skillMd(), dogfoodSkillMd()]) {
      // The Finish step reads the pr.draft knob and passes --draft to gh pr create
      // unless it returns false; draft governs creation only, so amendments never
      // re-draft an open PR.
      expect(text).toContain("pr.draft");
      expect(text).toContain("--draft");
      expect(text).toContain("config get pr.draft");
      expect(text).toContain("governs creation only");
      // The amendment sentence spells out that draft is a creation-time knob only.
      expect(text).toContain("does NOT change the PR's");
    }
  });
});
