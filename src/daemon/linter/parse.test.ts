import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePlan, slugify } from "./parse.js";

const validPlan = readFileSync(
  new URL("../../../test/fixtures/valid-plan.md", import.meta.url),
  "utf8",
);

function planWith(body: string): string {
  return `---
title: t
session: otc_test01
revision: 1
status: draft
created: 2026-06-13
---

${body}`;
}

describe("slugify", () => {
  test("derives section ids from heading text", () => {
    expect(slugify("Open Questions")).toBe("open-questions");
    expect(slugify("Summary")).toBe("summary");
    expect(slugify("  Phase 2 — Name!  ")).toBe("phase-2-name");
  });
});

describe("parsePlan on the valid fixture", () => {
  const plan = parsePlan(validPlan);

  test("has no parse errors", () => {
    expect(plan.parseErrors).toEqual([]);
  });

  test("parses frontmatter scalars", () => {
    expect(plan.frontmatter).toEqual({
      title: "auth-refactor",
      session: "otc_test01",
      revision: "1",
      status: "in_review",
      created: "2026-06-13",
    });
    expect(plan.frontmatterEndLine).toBe(7);
  });

  test("finds the five sections in order", () => {
    expect(plan.sections.map((s) => s.id)).toEqual([
      "summary",
      "decisions",
      "phases",
      "risks",
      "open-questions",
    ]);
  });

  test("summary: budget excludes blanks, fence delimiters, and fence content", () => {
    const summary = plan.sections[0]!;
    expect(summary.startLine).toBe(11);
    expect(summary.budgetedLineCount).toBe(2);
    expect(summary.fenceCount).toBe(1);
    expect(summary.listItems).toEqual([]);
  });

  test("decisions: list items with continuation lines", () => {
    const decisions = plan.sections[1]!;
    expect(decisions.listItems).toEqual([
      { startLine: 24, lineCount: 1 },
      { startLine: 25, lineCount: 2 },
    ]);
  });

  test("phase 1: plain labels, files list, details block with fence", () => {
    const phase = plan.sections[2]!.phases![0]!;
    expect(phase).toMatchObject({
      n: 1,
      name: "Token issuance",
      startLine: 30,
      headingValid: true,
      detailsCount: 1,
      strayH4s: [],
      fenceCount: 0,
    });
    expect(phase.fields.goal).toEqual({
      startLine: 32,
      budgetedLineCount: 1,
      listItemCount: 0,
    });
    expect(phase.fields.files).toEqual({
      startLine: 33,
      budgetedLineCount: 3,
      listItemCount: 2,
    });
    expect(phase.fields.verification?.budgetedLineCount).toBe(1);
    expect(phase.fields.outOfScope).toBeUndefined();
    expect(phase.details).toEqual({ startLine: 38, lineCount: 6 });
  });

  test("phase 2: bold labels, hyphen dash, out of scope", () => {
    const phase = plan.sections[2]!.phases![1]!;
    expect(phase).toMatchObject({ n: 2, name: "Middleware verification", headingValid: true });
    expect(phase.fields.goal?.budgetedLineCount).toBe(1);
    expect(phase.fields.files).toMatchObject({ budgetedLineCount: 2, listItemCount: 1 });
    expect(phase.fields.verification?.budgetedLineCount).toBe(1);
    expect(phase.fields.outOfScope?.budgetedLineCount).toBe(1);
    expect(phase.details).toBeUndefined();
    expect(phase.fenceCount).toBe(0);
  });

  test("risks and open questions list items", () => {
    expect(plan.sections[3]!.listItems.map((i) => i.lineCount)).toEqual([1, 1]);
    expect(plan.sections[4]!.listItems).toHaveLength(1);
  });
});

describe("parsePlan structure handling", () => {
  test("fences hide headings, phase markers, and list items", () => {
    const plan = parsePlan(
      planWith(
        "## Summary\n\nbefore\n\n```\n## Decisions\n### Phase 9 — fake\n- not a list item\n```\n\nafter\n",
      ),
    );
    expect(plan.sections).toHaveLength(1);
    const summary = plan.sections[0]!;
    expect(summary.budgetedLineCount).toBe(2);
    expect(summary.fenceCount).toBe(1);
    expect(summary.listItems).toEqual([]);
  });

  test("tilde fences work too", () => {
    const plan = parsePlan(planWith("## Summary\n\n~~~\n## Decisions\n~~~\ntext\n"));
    expect(plan.sections).toHaveLength(1);
    expect(plan.sections[0]!.budgetedLineCount).toBe(1);
  });

  test("missing frontmatter yields null", () => {
    const plan = parsePlan("## Summary\n\ntext\n");
    expect(plan.frontmatter).toBeNull();
    expect(plan.frontmatterEndLine).toBe(0);
    expect(plan.sections[0]!.budgetedLineCount).toBe(1);
  });

  test("unclosed frontmatter is a parse error", () => {
    const plan = parsePlan("---\ntitle: t\n\n## Summary\n");
    expect(plan.parseErrors.map((e) => e.code)).toEqual(["E_FRONTMATTER_UNCLOSED"]);
    expect(plan.frontmatter).toBeNull();
  });

  test("unclosed fence is a parse error", () => {
    const plan = parsePlan(planWith("## Summary\n\n```\ntrailing\n"));
    expect(plan.parseErrors.map((e) => e.code)).toEqual(["E_UNCLOSED_FENCE"]);
  });

  test("stray H4 inside a phase is recorded", () => {
    const plan = parsePlan(
      planWith("## Phases\n\n### Phase 1 — x\n\nGoal: g\n\n#### Notes\n\ntext\n"),
    );
    expect(plan.sections[0]!.phases![0]!.strayH4s).toHaveLength(1);
  });

  test("duplicate Details blocks bump detailsCount; first block wins", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\n#### Details\n\nfirst\n\n#### Details\n\nsecond\nthird\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.detailsCount).toBe(2);
    expect(phase.details!.lineCount).toBe(2);
  });

  test("invalid phase headings are flagged, valid dash variants accepted", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase one — bad\n\n### Phase 2 - ok\n\n### Setup\n",
      ),
    );
    const phases = plan.sections[0]!.phases!;
    expect(phases.map((p) => p.headingValid)).toEqual([false, true, false]);
    expect(phases[1]!.n).toBe(2);
  });

  test("H3 outside the Phases section is plain content", () => {
    const plan = parsePlan(planWith("## Summary\n\n### Sub heading\n\ntext\n"));
    expect(plan.sections[0]!.phases).toBeUndefined();
    expect(plan.sections[0]!.budgetedLineCount).toBe(2);
  });

  test("field content runs across blank lines until the next label", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: line one\nline two\n\nline three\nFiles:\n- a.ts\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.fields.goal!.budgetedLineCount).toBe(3);
    expect(phase.fields.files!.listItemCount).toBe(1);
  });

  test("details raw count includes blanks and fences within, not trailing blanks", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\n#### Details\n\na\n\n```\nb\n```\n\n\n### Phase 2 — y\n\nGoal: g\n",
      ),
    );
    const details = plan.sections[0]!.phases![0]!.details!;
    expect(details.lineCount).toBe(6);
  });
});
