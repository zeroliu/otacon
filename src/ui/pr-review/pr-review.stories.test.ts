import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RESPONSIVE_VIEWPORT_VALUE } from "storybook/viewport";
import preview from "../../../.storybook/preview.js";
import { balancedFixture, expertFixture } from "./fixtures.js";
import { BalancedDesktop, ExpertDesktop } from "./pr-review.stories.js";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

test("desktop stories fill the available Storybook canvas instead of forcing a clipped iframe", () => {
  expect(preview.initialGlobals?.viewport).toEqual({
    value: RESPONSIVE_VIEWPORT_VALUE,
    isRotated: false,
  });
  expect(BalancedDesktop.globals?.viewport).toEqual({
    value: RESPONSIVE_VIEWPORT_VALUE,
    isRotated: false,
  });
  expect(ExpertDesktop.globals?.viewport).toEqual({
    value: RESPONSIVE_VIEWPORT_VALUE,
    isRotated: false,
  });
});

test("review navigation stays vertical and reuses the production session-row grammar", () => {
  expect(css).not.toMatch(/\.pr-sidebar\s*\{/);
  expect(css).not.toMatch(/\.pr-side-list a\s*\{/);
  const switchRule = css.match(/\.pr-sidebar-switch\s*\{([^}]*)\}/)?.[1];
  expect(switchRule).toBeDefined();
  expect(switchRule).not.toContain("border-bottom");
  expect(css).toMatch(/\.pr-nav-row\s*\{[^}]*width:\s*100%;[^}]*\}/);
  expect(css).toMatch(/\.sl-row\s*\{/);
  expect(css).toMatch(/\.sl-text\s*\{/);
});

test("narrative fixtures prove Intuition supports long and single-block explanations", () => {
  expect(balancedFixture.report.intuition.blocks.length).toBeGreaterThan(2);
  expect(expertFixture.report.intuition.blocks).toHaveLength(1);
  expect(balancedFixture.report.intuition.goal.length).toBeGreaterThan(40);
  expect(expertFixture.report.intuition.goal.length).toBeGreaterThan(20);
  expect(css).not.toContain(".pr-intuition-grid");
});

test("Code fixtures require contract deltas before an ordered cross-module integration path", () => {
  const balancedCode = balancedFixture.report.code;
  expect(balancedCode.interfaces.items.map((item) => [item.status, item.kind])).toEqual([
    ["added", "type definition"],
    ["changed", "type definition"],
    ["changed", "function signature"],
  ]);
  const addedType = balancedCode.interfaces.items[0];
  const changedFunction = balancedCode.interfaces.items[2];
  if (addedType?.status !== "added") throw new Error("balanced fixture must start with its added type");
  if (changedFunction?.status !== "changed") throw new Error("balanced fixture must include its changed function");
  expect(addedType.after.code).toContain("interface ReviewKnowledgeSnapshot");
  expect(addedType.callerImpact).toContain("beginRevision callers must pass it");
  expect(changedFunction.before.code).toContain("pullRequest: PullRequestMeta");
  expect(changedFunction.after.code).toContain("snapshot: ReviewKnowledgeSnapshot");
  expect(balancedCode.integration.steps.map((step) => step.id)).toEqual([
    "integration-start",
    "integration-capture",
    "integration-begin",
    "integration-submit",
    "integration-grade",
  ]);
  expect(balancedCode.integration.steps.every((step) => step.module.length > 0 && step.symbol.length > 0 && step.handoff.length > 0)).toBe(true);
  expect(balancedCode.integration.trace.excerpt.code).toContain("knowledgeStore.capture(repositoryKey)");
  expect(balancedCode.integration.trace.excerpt.code).toContain("reviewStore.beginRevision({");
  expect(balancedCode.integration.trace.excerpt.code).toContain("snapshotId: revision.snapshotId");
  expect(balancedCode.integration.trace.excerpt.code).toContain("quizGrader.recordGrade");
  expect(balancedCode.integration.trace.excerpt.code).toContain("output: { id, headSha, snapshotId }");
  expect(balancedCode.integration.trace.excerpt.code).not.toContain("writeFile");
  expect(expertFixture.report.code.interfaces.items.some((item) => item.kind === "function signature")).toBe(true);
  expect(expertFixture.report.code.integration.steps.at(-1)?.id).toBe("integration-grade");
  expect(expertFixture.report.code.integration.trace).toBe(balancedCode.integration.trace);
  expect(css).not.toMatch(/\.pr-contract-status\.(?:added|changed|removed)/);
  expect(css).toContain('.pr-interface-change[data-contract-status="added"]');
  expect(css).toContain('.pr-contract-excerpt[data-state="before"] .fence');
  expect(css).toContain('.pr-contract-excerpt[data-state="after"] .fence');
  expect(css).not.toContain(".pr-surfaces code b::before");
  expect(css.match(/\.pr-interface-list\s*\{([^}]*)\}/)?.[1]).toContain("grid-template-columns: minmax(0, 1fr)");
  expect(css.match(/\.pr-contract-delta\s*\{([^}]*)\}/)?.[1]).toContain("grid-template-columns: minmax(0, 1fr)");
});
