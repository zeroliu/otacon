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
    expect(summary.fenceCount).toBe(0); // the only fence is a mermaid diagram, exempt from the cap
    expect(summary.diagramCount).toBe(1);
    expect(summary.listItems).toEqual([]);
  });

  test("decisions: list items with continuation lines and raw text", () => {
    const decisions = plan.sections[1]!;
    expect(decisions.listItems).toEqual([
      { startLine: 24, lineCount: 1, text: "- D1: RS256 over HS256 [assumed]" },
      {
        startLine: 25,
        lineCount: 2,
        text: "- D2: Sessions table stays until phase 3 [assumed]\n  Kept for rollback safety during the migration window.",
      },
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
      contentLines: [], // the goal text rides the label line, which is not captured
    });
    expect(phase.fields.files).toEqual({
      startLine: 33,
      budgetedLineCount: 3,
      listItemCount: 2,
      contentLines: [
        { text: "- src/auth/issuer.ts", line: 34 },
        { text: "- src/auth/keys.ts", line: 35 },
      ],
    });
    expect(phase.fields.verification?.budgetedLineCount).toBe(1);
    expect(phase.fields.outOfScope).toBeUndefined();
    expect(phase.details).toEqual({ startLine: 38, lineCount: 6 });
  });

  test("phase 2: bold labels, hyphen dash, Files table, out of scope", () => {
    const phase = plan.sections[2]!.phases![1]!;
    expect(phase).toMatchObject({ n: 2, name: "Middleware verification", headingValid: true });
    expect(phase.fields.goal?.budgetedLineCount).toBe(1);
    // Files authored as a GFM table: no list items, budget-exempt, captured as
    // content lines so rules.ts can require a filled "What changed" cell.
    expect(phase.fields.files).toMatchObject({
      startLine: 49,
      budgetedLineCount: 1,
      listItemCount: 0,
      contentLines: [
        { text: "| File | What changed |", line: 51 },
        { text: "| ---- | ------------ |", line: 52 },
        {
          text: "| `src/middleware/jwt.ts` | verify the JWT and reject expired or bad-signature requests |",
          line: 53,
        },
        { text: "| `src/middleware/index.ts` | wire the verifier into the middleware chain |", line: 54 },
      ],
    });
    // A Files table is exempt from the per-phase visual cap (required structure).
    expect(phase.visualCount).toBe(0);
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

describe("phase field content-line capture", () => {
  test("a Files list captures each bullet line (label line excluded)", () => {
    const plan = parsePlan(
      planWith("## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\n- b.ts\nVerification: t\n"),
    );
    const files = plan.sections[0]!.phases![0]!.fields.files!;
    expect(files.contentLines).toEqual([
      { text: "- a.ts", line: 15 },
      { text: "- b.ts", line: 16 },
    ]);
  });

  test("a Files table captures the header, delimiter, and body rows", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n| File | What changed |\n| - | - |\n| `a.ts` | adds X |\nVerification: t\n",
      ),
    );
    const files = plan.sections[0]!.phases![0]!.fields.files!;
    expect(files.contentLines).toEqual([
      { text: "| File | What changed |", line: 15 },
      { text: "| - | - |", line: 16 },
      { text: "| `a.ts` | adds X |", line: 17 },
    ]);
  });
});

describe("gwt block capture", () => {
  test("a gwt fence under Verification is captured, budget-exempt", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: passes\n```gwt\nGiven a\nWhen b\nThen c\n```\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.fenceCount).toBe(0); // gwt does not spend the one-fence allowance
    expect(phase.gwtBlocks).toHaveLength(1);
    expect(phase.gwtBlocks[0]!.field).toBe("verification");
    // Scenarios are tokenized once at parse time (parse.ts), so rules.ts and any
    // UI consumer read the same array instead of re-parsing the fence body.
    expect(phase.gwtBlocks[0]!.scenarios).toHaveLength(1);
    expect(phase.gwtBlocks[0]!.scenarios[0]!.valid).toBe(true);
  });

  test("a gwt fence under another field records that field (placement check fodder)", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\n```gwt\nGiven a\nWhen b\nThen c\n```\nVerification: t\n",
      ),
    );
    expect(plan.sections[0]!.phases![0]!.gwtBlocks[0]!.field).toBe("files");
  });

  test("a gwt fence inside Details is detail content, not a captured block", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n#### Details\n\n```gwt\nGiven a\nWhen b\nThen c\n```\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.gwtBlocks).toEqual([]);
    expect(phase.details!.lineCount).toBeGreaterThan(0);
  });

  test("a normal fence still counts toward the phase fence cap", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n```ts\nconst x = 1;\n```\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.fenceCount).toBe(1);
    expect(phase.gwtBlocks).toEqual([]);
  });
});

describe("callout detection", () => {
  test("a known callout is budget-exempt and counts as one visual", () => {
    const plan = parsePlan(
      planWith("## Summary\n\nShip it.\n\n> [!risk]\n> Rolling the key drops live sessions.\n"),
    );
    const summary = plan.sections[0]!;
    expect(summary.budgetedLineCount).toBe(1); // only "Ship it." counts
    expect(summary.visualCount).toBe(1);
  });

  test("plain blockquotes and unknown markers stay budgeted prose", () => {
    const plain = parsePlan(planWith("## Summary\n\n> a plain quote\n> second line\n"));
    expect(plain.sections[0]!.budgetedLineCount).toBe(2);
    expect(plain.sections[0]!.visualCount).toBe(0);

    const unknown = parsePlan(planWith("## Summary\n\n> [!warning]\n> not in the set\n"));
    expect(unknown.sections[0]!.budgetedLineCount).toBe(2);
    expect(unknown.sections[0]!.visualCount).toBe(0);
  });

  test("only a marker on the blockquote's first line opens a callout", () => {
    const plan = parsePlan(planWith("## Summary\n\n> lead line\n> [!risk]\n> trailing\n"));
    // The marker is a continuation line, so this is one plain (budgeted) quote.
    expect(plan.sections[0]!.budgetedLineCount).toBe(3);
    expect(plan.sections[0]!.visualCount).toBe(0);
  });

  test("callouts count per-section and per-phase, separately from fences", () => {
    const plan = parsePlan(
      planWith(
        "## Summary\n\n> [!note]\n> one\n\n> [!risk]\n> two\n\n## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n> [!decision]\n> chose A\n",
      ),
    );
    expect(plan.sections[0]!.visualCount).toBe(2);
    const phase = plan.sections[1]!.phases![0]!;
    expect(phase.visualCount).toBe(1);
    expect(phase.fields.verification!.budgetedLineCount).toBe(1); // callout didn't touch it
  });

  test("callouts inside Details do not count toward the phase visual cap", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\n\n#### Details\n\n> [!risk]\n> detail-level\n",
      ),
    );
    const phase = plan.sections[0]!.phases![0]!;
    expect(phase.visualCount).toBe(0);
    expect(phase.details!.lineCount).toBeGreaterThan(0);
  });
});

describe("lead diagram + opt-out detection", () => {
  test("the valid fixture's Summary mermaid is counted as a diagram", () => {
    const summary = parsePlan(validPlan).sections[0]!;
    expect(summary.diagramCount).toBe(1);
    expect(summary.fenceCount).toBe(0); // a mermaid diagram is exempt from the fence cap
    expect(summary.leadDiagramOptOut).toBeFalse();
  });

  test("a non-mermaid fence is not a diagram", () => {
    const summary = parsePlan(planWith("## Summary\n\n```ts\nconst x = 1;\n```\n")).sections[0]!;
    expect(summary.diagramCount).toBe(0);
    expect(summary.fenceCount).toBe(1);
  });

  test("the no-lead-diagram marker sets the flag and is budget-exempt", () => {
    const summary = parsePlan(
      planWith("## Summary\n\nShip it.\n<!-- no-lead-diagram: docs only -->\n"),
    ).sections[0]!;
    expect(summary.leadDiagramOptOut).toBeTrue();
    expect(summary.budgetedLineCount).toBe(1); // only "Ship it." counts
    expect(summary.diagramCount).toBe(0);
  });

  test("a bare marker with no reason still opts out", () => {
    const summary = parsePlan(planWith("## Summary\n\n<!-- no-lead-diagram -->\n")).sections[0]!;
    expect(summary.leadDiagramOptOut).toBeTrue();
  });
});

describe("mermaid is exempt from the fence cap", () => {
  test("a section's mermaid fence counts as a diagram, never toward the fence cap", () => {
    const summary = parsePlan(
      planWith("## Summary\n\n```mermaid\ngraph TD\n  A --> B\n```\n"),
    ).sections[0]!;
    expect(summary.diagramCount).toBe(1);
    expect(summary.fenceCount).toBe(0);
  });

  test("a mermaid fence and a code fence: only the code fence counts toward the cap", () => {
    const summary = parsePlan(
      planWith("## Summary\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```ts\nconst x = 1;\n```\n"),
    ).sections[0]!;
    expect(summary.fenceCount).toBe(1); // only the ```ts code fence
    expect(summary.diagramCount).toBe(1);
  });

  test("two mermaid fences in a section: zero toward the cap, two diagrams", () => {
    const summary = parsePlan(
      planWith(
        "## Summary\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nsequenceDiagram\n  X->>Y: hi\n```\n",
      ),
    ).sections[0]!;
    expect(summary.fenceCount).toBe(0);
    expect(summary.diagramCount).toBe(2);
  });

  test("a phase mermaid fence is exempt; a phase code fence still counts", () => {
    const phaseMermaid = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n```mermaid\ngraph TD\n  A --> B\n```\n",
      ),
    ).sections[0]!.phases![0]!;
    expect(phaseMermaid.fenceCount).toBe(0);

    const phaseCode = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n```ts\nconst x = 1;\n```\n",
      ),
    ).sections[0]!.phases![0]!;
    expect(phaseCode.fenceCount).toBe(1);
  });
});

describe("mermaid diagram fence capture", () => {
  test("captures each mermaid fence's body, start line, and section slug", () => {
    const plan = parsePlan(
      planWith(
        "## Summary\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n## Impact\n\n```mermaid\nsequenceDiagram\n  X->>Y: hi\n```\n",
      ),
    );
    expect(plan.diagrams).toHaveLength(2);
    expect(plan.diagrams[0]).toEqual({
      code: "graph TD\n  A --> B",
      startLine: 11,
      section: "summary",
    });
    expect(plan.diagrams[1]).toEqual({
      code: "sequenceDiagram\n  X->>Y: hi",
      startLine: 18,
      section: "impact",
    });
  });

  test("the captured code is body-only and preserves inner newlines", () => {
    const plan = parsePlan(
      planWith("## Summary\n\n```mermaid\ngraph TD\n\n  A --> B\n```\n"),
    );
    expect(plan.diagrams).toHaveLength(1);
    expect(plan.diagrams[0]!.code).toBe("graph TD\n\n  A --> B");
    expect(plan.diagrams[0]!.code).not.toContain("```");
  });

  test("a tilde-fenced ~~~mermaid block is captured", () => {
    const plan = parsePlan(planWith("## Summary\n\n~~~mermaid\ngraph TD\n  A --> B\n~~~\n"));
    expect(plan.diagrams).toHaveLength(1);
    expect(plan.diagrams[0]!.code).toBe("graph TD\n  A --> B");
    expect(plan.diagrams[0]!.section).toBe("summary");
  });

  test("a mermaid fence with a trailing info token is still captured", () => {
    const plan = parsePlan(planWith("## Summary\n\n```mermaid title here\ngraph TD\n  A --> B\n```\n"));
    expect(plan.diagrams).toHaveLength(1);
    expect(plan.diagrams[0]!.code).toBe("graph TD\n  A --> B");
  });

  test("a non-mermaid fence does not appear in diagrams", () => {
    const plan = parsePlan(planWith("## Summary\n\n```ts\nconst x = 1;\n```\n"));
    expect(plan.diagrams).toEqual([]);
    expect(plan.sections[0]!.diagramCount).toBe(0);
  });

  test("a mermaid fence inside a phase Details block is not captured", () => {
    const plan = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\n\n#### Details\n\n```mermaid\ngraph TD\n  A --> B\n```\n",
      ),
    );
    expect(plan.diagrams).toEqual([]);
    expect(plan.sections[0]!.phases![0]!.details!.lineCount).toBeGreaterThan(0);
  });
});

describe("table (decision matrix) detection", () => {
  test("a GFM table is budget-exempt and counts as one visual", () => {
    const plan = parsePlan(
      planWith("## Summary\n\nShip it.\n\n| Pick | Option |\n| --- | --- |\n| ✓ | A |\n| | B |\n"),
    );
    const summary = plan.sections[0]!;
    expect(summary.budgetedLineCount).toBe(1); // only "Ship it." counts
    expect(summary.visualCount).toBe(1);
  });

  test("a pipe in prose without a delimiter row is not a table", () => {
    const plan = parsePlan(planWith("## Summary\n\nuse a | b style\nplain prose\n"));
    expect(plan.sections[0]!.budgetedLineCount).toBe(2);
    expect(plan.sections[0]!.visualCount).toBe(0);
  });

  test("a table in a phase read path counts toward the phase, not Details", () => {
    const inRead = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\nFiles:\n- a.ts\nVerification: t\n\n| Opt | x |\n| - | - |\n| ✓ | A |\n",
      ),
    );
    expect(inRead.sections[0]!.phases![0]!.visualCount).toBe(1);

    const inDetails = parsePlan(
      planWith(
        "## Phases\n\n### Phase 1 — x\n\nGoal: g\n\n#### Details\n\n| Opt | x |\n| - | - |\n| A | 1 |\n",
      ),
    );
    expect(inDetails.sections[0]!.phases![0]!.visualCount).toBe(0);
  });

  test("callouts and tables share the per-section visual count", () => {
    const plan = parsePlan(
      planWith(
        "## Summary\n\n> [!note]\n> n\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
      ),
    );
    expect(plan.sections[0]!.visualCount).toBe(2);
  });

  test("a table bumps matrixCount; a callout-only Summary leaves it 0", () => {
    const withMatrix = parsePlan(
      planWith("## Summary\n\nShip it.\n\n| Pick | Option |\n| --- | --- |\n| ✓ | A |\n| | B |\n"),
    ).sections[0]!;
    expect(withMatrix.matrixCount).toBe(1);

    // A callout still counts as a visual, but it is not a matrix, so L7 must keep
    // nudging a Summary whose only visual is a callout (it doesn't show shape).
    const calloutOnly = parsePlan(
      planWith("## Summary\n\nShip it.\n\n> [!risk]\n> rolling the key drops live sessions\n"),
    ).sections[0]!;
    expect(calloutOnly.visualCount).toBe(1);
    expect(calloutOnly.matrixCount).toBe(0);
  });
});
