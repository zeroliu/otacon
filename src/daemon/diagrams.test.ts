import { describe, expect, test } from "bun:test";
import { validateDiagrams } from "./diagrams.js";

// A plan body wrapped in the minimal frontmatter the parser expects. The body
// goes under a Summary section so its ```mermaid fences are captured as section
// read-path diagrams (DiagramFence) the validator walks.
const plan = (body: string): string => `---
title: t
session: otc_test01
revision: 1
status: in_review
created: 2026-06-13
---

## Summary

${body}`;

const fence = (code: string): string => "```mermaid\n" + code + "\n```";

// Inputs chosen empirically against this headless mermaid setup:
//  - VALID: a plain flowchart mermaid parses cleanly.
//  - INVALID: an unknown diagram type ("notadiagram") — mermaid rejects with
//    "No diagram type detected matching given configuration for text:…".
//    Deliberately NOT an unbalanced bracket or similar: mermaid is lenient
//    about some malformed-but-typed input, but a bogus *type* deterministically
//    rejects because mermaid can't even pick a grammar.
const VALID = "flowchart LR\n  A[Start] --> B[End]";
const INVALID = "notadiagram\n  a-->b";
// A *typed* fence with a grammar error: mermaid picks the flowchart grammar then
// rejects mid-parse with a multi-line "Parse error on line N:" message whose
// actionable detail ("Expecting …, got 'X'") sits on the LAST line.
const GRAMMAR_ERROR = "flowchart LR\n  A --> --> B";

describe("validateDiagrams", () => {
  test("a valid mermaid fence produces no issues", async () => {
    const issues = await validateDiagrams(plan(fence(VALID)));
    expect(issues).toEqual([]);
  });

  test("a plan with no mermaid fences returns [] quickly", async () => {
    const issues = await validateDiagrams(
      plan("Just prose, no diagrams here.\n\n## Decisions\n\n- D1: a thing"),
    );
    expect(issues).toEqual([]);
  });

  test("a malformed mermaid fence yields exactly one L8 issue anchored to it", async () => {
    const body = "Lead paragraph.\n\n" + fence(INVALID);
    const issues = await validateDiagrams(plan(body));
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.rule).toBe("L8");
    expect(issue.code).toBe("E_DIAGRAM_UNRENDERABLE");
    expect(issue.severity).toBe("error");
    expect(issue.section).toBe("summary");
    // The fence opens on the line carrying ```mermaid. Frontmatter is 6 lines +
    // the ---/--- pair, then a blank, "## Summary", blank, the lead paragraph,
    // blank, then the fence. Rather than hard-code arithmetic, assert it points
    // at the actual ```mermaid line.
    const lines = plan(body).split("\n");
    const expectedLine = lines.findIndex((l) => l.trim() === "```mermaid") + 1;
    expect(issue.line).toBe(expectedLine);
    expect(issue.message).toContain("Diagram does not render");
  });

  test("one valid and one invalid fence → one issue, on the invalid fence", async () => {
    const body = fence(VALID) + "\n\nMiddle prose.\n\n" + fence(INVALID);
    const full = plan(body);
    const issues = await validateDiagrams(full);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.rule).toBe("L8");
    // Anchored to the SECOND fence (the invalid one), not the first.
    const lines = full.split("\n");
    const fenceLines = lines
      .map((l, i) => (l.trim() === "```mermaid" ? i + 1 : -1))
      .filter((n) => n > 0);
    expect(fenceLines).toHaveLength(2);
    expect(issue.line).toBe(fenceLines[1]);
  });

  test("a grammar-error fence keeps the actionable detail on one line", async () => {
    const issues = await validateDiagrams(plan(fence(GRAMMAR_ERROR)));
    expect(issues).toHaveLength(1);
    const { message } = issues[0]!;
    // Still one line (no embedded newline — the source excerpt and caret pointer
    // are dropped) but it carries both the "Parse error" header and the actual
    // "got '…'" cause, not just the bare header.
    expect(message).not.toContain("\n");
    expect(message).toContain("Parse error on line");
    expect(message).toContain("got '");
  });
});
