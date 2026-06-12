// Parity pins for the ported line grammar (DECISIONS.md "Review screen
// renders via a ported line grammar, not the linter parser"): the shapes that
// must never drift from the daemon linter — phase slugs and the L6 Details
// line measure — are asserted against the linter parser itself, on the same
// input. Runs under the root tsconfig/bun (no DOM needed).

import { describe, expect, test } from "bun:test";
import { parsePlan as linterParse } from "../../../src/daemon/linter/parse.js";
import { parsePlan, slugify } from "./parse.js";

const plan = (phasesBody: string, preamble = "# t\n"): string => `---
title: t
session: otc_x
revision: 1
status: in_review
created: 2026-06-13
---

${preamble}
## Summary

One line.

## Decisions

- D1: choice

## Phases

${phasesBody}
## Risks

- a risk

## Open Questions

- a question
`;

const PHASE = (heading: string, details = "") => `${heading}
Goal: g
Files:

- a.ts
Verification: v
${details}
`;

describe("phase ids match the linter's phaseSlug", () => {
  test("zero-padded numbering normalizes: Phase 01 anchors as phase-1", () => {
    const source = plan(PHASE("### Phase 01 — Zero padded", "#### Details\n\nbody\n"));
    const ui = parsePlan(source);
    const linter = linterParse(source);

    const phase = ui.sections.find((s) => s.id === "phases")?.phases[0];
    const linterPhase = linter.sections.find((s) => s.id === "phases")?.phases?.[0];
    expect(phase?.id).toBe(`phase-${linterPhase!.n}`); // the linter's phaseSlug shape
    expect(phase?.id).toBe("phase-1");
    expect(phase?.n).toBe(1);
  });
});

describe("Details line measure matches L6", () => {
  test("fences, trailing blanks, and EOF details all count identically", () => {
    const details = `#### Details

prose line

\`\`\`ts
const x = 1;
\`\`\`

last line


`;
    const source = plan(PHASE("### Phase 1 — One", details));
    const ui = parsePlan(source);
    const linter = linterParse(source);

    const uiDetails = ui.sections.find((s) => s.id === "phases")?.phases[0]?.details;
    const linterDetails = linter.sections.find((s) => s.id === "phases")?.phases?.[0]?.details;
    expect(uiDetails?.lineCount).toBe(linterDetails!.lineCount);
  });
});

describe("section slugs", () => {
  test("slugify matches the linter contract", () => {
    for (const title of ["Open Questions", "Summary", "A — Weird  Title!"]) {
      expect(slugify(title)).toBe(
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, ""),
      );
    }
  });
});

describe("fail-soft tolerance", () => {
  test("before/after fences pair only when adjacent", () => {
    const body = `#### Details

\`\`\`ts before
old();
\`\`\`

\`\`\`ts after
new_();
\`\`\`

\`\`\`ts after
lone();
\`\`\`
`;
    const doc = parsePlan(plan(PHASE("### Phase 1 — One", body)));
    const blocks = doc.sections.find((s) => s.id === "phases")?.phases[0]?.details?.blocks ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(["pair", "fence"]);
  });

  test("a leading H1 is the title; an H1 after preamble prose stays content", () => {
    const leading = parsePlan(plan("### Phase 1 — One\nGoal: g\nFiles:\n\n- a.ts\nVerification: v\n"));
    expect(leading.title).toBe("t");

    const mid = parsePlan(plan(
      "### Phase 1 — One\nGoal: g\nFiles:\n\n- a.ts\nVerification: v\n",
      "intro prose\n\n# Not The Title\n",
    ));
    expect(mid.title).toBeNull();
    const preambleText = mid.preamble
      .map((b) => (b.kind === "markdown" ? b.text : ""))
      .join("\n");
    expect(preambleText).toContain("# Not The Title");
    expect(preambleText).toContain("intro prose");
  });

  test("an unclosed fence never loses content (runs to EOF; the linter rejects it anyway)", () => {
    const doc = parsePlan(plan(PHASE("### Phase 1 — One", "#### Details\n\n```ts\nunclosed()\n")));
    const blocks = doc.sections.find((s) => s.id === "phases")?.phases[0]?.details?.blocks ?? [];
    expect(blocks[0]?.kind).toBe("fence");
    expect((blocks[0] as { code: string }).code).toContain("unclosed()");
  });
});
