import { describe, expect, test } from "bun:test";

import { parseReviewReport, stripReviewCodeGroupMetadata } from "./review-report.js";

const snapshot = "a".repeat(64);
const report = (sections = ["Background", "Intuition", "Code", "Quiz"]) => `---
type: otacon-pr-review
version: 1
session: otc_report1
revision: 2
pr: github.com/acme/app#42
head: abc123
knowledge-snapshot: ${snapshot}
altitude: balanced
---

${sections.map((section) => section === "Code" ? `## Code

Read contracts before wiring.

### Interface changes — Snapshot contract

**Purpose:** Freeze the authoring input.
**Changed behavior:** Revisions now point at a copied snapshot.
**Surfaces:** \`src/shared/review.ts#ReviewSnapshot\`, \`src/daemon/review-store.ts#beginRevision\`

\`\`\`ts
type ReviewSnapshot = { hash: string };
\`\`\`

### Integration path — Capture before submit

**Purpose:** Follow the runtime handoff.
**Changed behavior:** Submit verifies snapshot ownership.
**Surfaces:** \`src/daemon/app.ts#POST-review-submit\`

### Implementation walkthrough — Atomic commit

**Purpose:** Inspect the crash boundary.
**Changed behavior:** Content is renamed into place once.
**Surfaces:** \`src/daemon/review-store.ts#submit\`
` : `## ${section}

${section} explanation.
`).join("\n")}`;

describe("parseReviewReport", () => {
  test("parses fixed frontmatter, ordered sections, and exact code-group source ranges", () => {
    const parsed = parseReviewReport(report());
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter).toMatchObject({ revision: 2, altitude: "balanced" });
    expect(parsed.sections.map((section) => section.name)).toEqual(["Background", "Intuition", "Code", "Quiz"]);
    expect(parsed.codeGroups.map((group) => group.kind)).toEqual(["interface", "integration", "implementation"]);
    expect(parsed.codeGroups[0]).toMatchObject({
      title: "Snapshot contract",
      purpose: "Freeze the authoring input.",
      changedBehavior: "Revisions now point at a copied snapshot.",
      surfaces: [
        { file: "src/shared/review.ts", symbol: "ReviewSnapshot" },
        { file: "src/daemon/review-store.ts", symbol: "beginRevision" },
      ],
    });
    const lines = report().split("\n");
    const first = parsed.codeGroups[0]!;
    expect(lines.slice(first.startLine - 1, first.endLine).join("\n")).toContain("type ReviewSnapshot");
    expect(lines[first.endLine]).toMatch(/^### Integration path/);
  });

  test("rejects reordered required sections but recovers them for display", () => {
    const parsed = parseReviewReport(report(["Intuition", "Background", "Code", "Quiz"]));
    expect(parsed.errors.map((issue) => issue.code)).toContain("E_REPORT_SECTION_ORDER");
    expect(parsed.sections.map((section) => section.name)).toEqual(["Intuition", "Background", "Code", "Quiz"]);
  });

  test("uses an unknown H2 as a recovery boundary instead of merging it into a known section", () => {
    const damaged = report().replace("## Intuition", "## Appendix\n\nDo not merge this.\n\n## Intuition");
    const parsed = parseReviewReport(damaged);
    expect(parsed.errors.map((issue) => issue.code)).toContain("E_REPORT_SECTION_UNKNOWN");
    expect(parsed.sections.find((section) => section.name === "Background")?.markdown).not.toContain("Appendix");
    expect(parsed.sections.find((section) => section.name === "Intuition")?.markdown).toContain("Intuition explanation");
  });

  test("does not treat headings inside fences as report structure", () => {
    const parsed = parseReviewReport(report().replace("Background explanation.", "```md\n## Quiz\n```"));
    expect(parsed.sections.map((section) => section.name)).toEqual(["Background", "Intuition", "Code", "Quiz"]);
  });

  test("does not close a fence on delimiter-prefixed code with trailing text", () => {
    const fenced = report().replace(
      "Background explanation.",
      "````md\n````not-a-closing-fence\n## Quiz\n````",
    );
    expect(parseReviewReport(fenced).sections.map((section) => section.name)).toEqual([
      "Background", "Intuition", "Code", "Quiz",
    ]);
  });

  test("does not accept metadata labels hidden inside code fences", () => {
    const damaged = report().replace(
      "**Purpose:** Freeze the authoring input.",
      "```md\n**Purpose:** This is code, not report metadata.\n```",
    );
    const parsed = parseReviewReport(damaged);
    expect(parsed.codeGroups[0]?.purpose).toBeUndefined();
    expect(stripReviewCodeGroupMetadata(parsed.codeGroups[0]!.markdown)).toContain(
      "**Purpose:** This is code, not report metadata.",
    );
  });

  test("rejects duplicate and partly malformed surface metadata", () => {
    const duplicate = report().replace(
      "**Purpose:** Freeze the authoring input.",
      "**Purpose:** Freeze the authoring input.\n**Purpose:** Duplicate ownership statement.",
    );
    expect(parseReviewReport(duplicate).errors.map((issue) => issue.code)).toContain(
      "E_REPORT_GROUP_METADATA_DUPLICATE",
    );
    const malformed = report().replace(
      "`src/shared/review.ts#ReviewSnapshot`, `src/daemon/review-store.ts#beginRevision`",
      "`src/shared/review.ts#ReviewSnapshot`, not-backticked",
    );
    expect(parseReviewReport(malformed).errors.map((issue) => issue.code)).toContain(
      "E_REPORT_GROUP_SURFACE",
    );
  });

  test("gives non-Latin group titles semantic anchors instead of order-based ids", () => {
    const localized = report().replace("Snapshot contract", "冻结快照");
    const id = parseReviewReport(localized).codeGroups[0]?.id;
    expect(id).toMatch(/^code-interface-u[0-9a-f]+/);
    expect(id).not.toBe("code-interface-1");
  });
});
