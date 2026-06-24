import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Ledger } from "../../shared/types";
import PlanView from "./plan-view";

function render(markdown: string, verificationLedger?: Ledger): string {
  return renderToStaticMarkup(
    createElement(PlanView, { markdown, warnings: [], verificationLedger }),
  );
}

function renderDrift(shippedBeyondPlan: string): string {
  // A bare Phases shell so nothing routes through the Markdown renderer
  // (DOMPurify is unavailable under the headless test runtime) — only the
  // drift callout this test cares about renders.
  const markdown = ["## Phases", "", "### Phase 1 — x", "", "Verification:", ""].join("\n");
  return renderToStaticMarkup(
    createElement(PlanView, { markdown, warnings: [], shippedBeyondPlan }),
  );
}

const SCEN = (g: string) => `Given ${g}\nWhen the agent runs it\nThen it passes`;

describe("PlanView verify-before-merge badge keying", () => {
  // A phase with TWO Verification fields (linter-legal): the daemon flattens
  // their gwt scenarios into one phase-wide 0-based index, so the second field's
  // lone scenario is flat index 1 — the badge must read ledger[1][1], not [1][0].
  // Bare Verification labels (no inline prose) and no Goal/Files so nothing
  // routes through the Markdown renderer (DOMPurify is unavailable under the
  // headless test runtime) — the parser is tolerant of the missing fields, and
  // the only rendered content is the gwt scenario cards this test cares about.
  const twoVerificationFields = [
    "## Phases",
    "",
    "### Phase 1 — issuance",
    "",
    "Verification:",
    "```gwt",
    SCEN("the first assertion"),
    "```",
    "Verification:",
    "```gwt",
    SCEN("the second assertion"),
    "```",
    "",
  ].join("\n");

  test("the second Verification field's scenario keys off the phase-wide flat index", () => {
    // Only the second scenario (flat index 1) is attested. If the UI restarted
    // the base at 0 per field this badge would never render (and the first
    // scenario would wrongly show it).
    const ledger: Ledger = {
      1: { 1: { status: "pass", evidence: "second assertion covered" } },
    };
    const html = render(twoVerificationFields, ledger);
    expect(html).toContain("gwt-badge-verified");
    expect(html).toContain('title="second assertion covered"');
  });

  test("an entry at the per-field index 0 does NOT badge the second field's scenario", () => {
    // ledger[1][0] belongs to the FIRST field's scenario; the second field's
    // scenario (flat index 1) must stay unbadged. A regression where the second
    // field restarts at base 0 would surface this badge in the wrong place.
    const ledger: Ledger = {
      1: { 0: { status: "pass", evidence: "first assertion covered" } },
    };
    const html = render(twoVerificationFields, ledger);
    // Exactly one badge renders (for the first field's scenario).
    expect(html.match(/gwt-badge-verified/g) ?? []).toHaveLength(1);
    expect(html).toContain('title="first assertion covered"');
  });
});

describe("PlanView shipped-beyond-plan drift callout (Phase 3)", () => {
  // Scenario 1 (UI): the advisory callout renders the uncited changed file.
  test("renders the advisory callout listing each uncited changed file", () => {
    const html = renderDrift("src/foo.ts\nsrc/daemon/staging-gate.ts");
    expect(html).toContain("shipped-beyond");
    expect(html).toContain("Shipped beyond the plan");
    expect(html).toContain("<code>src/foo.ts</code>");
    expect(html).toContain("<code>src/daemon/staging-gate.ts</code>");
    // The copy makes clear it is advisory, not a gate.
    expect(html).toContain("advisory");
  });

  // Scenario 2 (UI): no drift → the callout degrades to nothing.
  test("renders nothing when there is no drift", () => {
    expect(renderDrift("")).not.toContain("shipped-beyond");
  });
});
