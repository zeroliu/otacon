import { describe, expect, test } from "bun:test";

import { lintReviewReport } from "./review-linter.js";

const snapshot = "a".repeat(64);
const frontmatter = `---
type: otacon-pr-review
version: 1
session: otc_lint1
revision: 1
pr: github.com/acme/app#9
head: abc
knowledge-snapshot: ${snapshot}
altitude: expert
---`;

const group = (layer: string, title: string) => `### ${layer} — ${title}

**Purpose:** Explain why this boundary belongs in the reader's causal path.
**Changed behavior:** Calls now preserve the frozen value instead of reading mutable state.
**Surfaces:** \`src/example.ts#${title.replaceAll(" ", "")}\`

The details make the handoff concrete.`;

const valid = `${frontmatter}

## Background

The old authoring input could move.
That made a report hard to explain later.

## Intuition

Treat a snapshot as a labeled photograph.
Later learning belongs to the next photograph.

## Code

Read the public contract before following the runtime.

${group("Interface changes", "Snapshot contract")}

${group("Interface changes", "Revision contract")}

${group("Integration path", "Capture handoff")}

${group("Implementation walkthrough", "Atomic rename")}

## Quiz

Structured quiz cards render here.
`;

describe("lintReviewReport", () => {
  test("accepts multiple typed groups while preserving causal layer order", () => {
    const result = lintReviewReport(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.parsed.codeGroups.map((item) => item.kind)).toEqual([
      "interface", "interface", "integration", "implementation",
    ]);
  });

  test("hard-fails required section and causal group ordering", () => {
    const reorderedSections = valid.replace("## Background", "## TEMP").replace("## Intuition", "## Background").replace("## TEMP", "## Intuition");
    expect(lintReviewReport(reorderedSections).errors.map((issue) => issue.code)).toContain("E_REPORT_SECTION_ORDER");
    const reorderedGroups = valid.replace(
      `${group("Integration path", "Capture handoff")}\n\n${group("Implementation walkthrough", "Atomic rename")}`,
      `${group("Implementation walkthrough", "Atomic rename")}\n\n${group("Integration path", "Capture handoff")}`,
    );
    expect(lintReviewReport(reorderedGroups).errors.map((issue) => issue.code)).toContain("E_REPORT_GROUP_ORDER");
  });

  test("requires purpose, changed behavior, and file#symbol surfaces", () => {
    const damaged = valid
      .replace("**Purpose:** Explain why this boundary belongs in the reader's causal path.\n", "")
      .replace("**Changed behavior:** Calls now preserve the frozen value instead of reading mutable state.\n", "")
      .replace("**Surfaces:** `src/example.ts#Snapshotcontract`", "**Surfaces:** not-a-surface");
    const codes = lintReviewReport(damaged).errors.map((issue) => issue.code);
    expect(codes).toContain("E_REPORT_GROUP_PURPOSE");
    expect(codes).toContain("E_REPORT_GROUP_BEHAVIOR");
    expect(codes).toContain("E_REPORT_GROUP_SURFACES");
  });

  test("bounds quality warnings even for a pathological report", () => {
    const thin = valid
      .replaceAll("Explain why this boundary belongs in the reader's causal path.", "Short")
      .replaceAll("Calls now preserve the frozen value instead of reading mutable state.", "Changed");
    expect(lintReviewReport(thin).warnings.length).toBeLessThanOrEqual(8);
    expect(lintReviewReport(thin).warnings.some((issue) => issue.code === "W_REPORT_PURPOSE_THIN")).toBe(true);
  });
});
